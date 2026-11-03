use crate::input::TextInput;
use dispatch_rs::{
    config::Workspace,
    model::*,
    runner::Queue,
    service::{Command, Handle, Snapshot},
};
use gpui::{prelude::*, *};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const GREEN: u32 = 0x00745e;
const INK: u32 = 0x26332f;
const MUTED: u32 = 0x6d7974;
const LINE: u32 = 0xdde4e0;

#[derive(Clone)]
enum Action {
    Connect,
    Settings,
    Close,
    Add,
    Switch(String),
    Remove(String),
    ConfirmRemove(String),
    Refresh,
    SaveBranch,
    Multiple,
    Select(u64),
    Play(u64),
    Options(u64),
    Move(usize, bool),
    Drop(u64),
    Clear,
    Launch,
    SaveInputs,
    Stop,
    Activity(bool),
    Filter,
    Sort,
    Open(String),
    Dismiss,
    Quit,
    ConfirmQuit,
}
struct Draft {
    branch: Entity<TextInput>,
    search: Entity<TextInput>,
    selected: Vec<u64>,
    multiple: bool,
    filter: usize,
    sort: usize,
    inputs: HashMap<(u64, String), Map<String, Value>>,
}
struct Form {
    workflow: u64,
    branch: String,
    schema: Schema,
    fields: Vec<Entity<TextInput>>,
    launching: bool,
}
enum Dialog {
    Connect,
    Settings,
    Remove(String),
    Loading(u64, String, bool),
    Inputs(Form),
    Quit,
}

pub struct Dispatch {
    handle: Handle,
    state: Snapshot,
    queue: Queue,
    drafts: HashMap<String, Draft>,
    repository: Entity<TextInput>,
    dialog: Option<Dialog>,
    activity: bool,
    launch_remaining: Vec<u64>,
    launch_ids: Vec<u64>,
    local_error: Option<String>,
    close_requested: Arc<AtomicBool>,
    last_refresh: Instant,
    focus: FocusHandle,
}
impl Dispatch {
    pub fn new(handle: Handle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let close_requested = Arc::new(AtomicBool::new(false));
        let closed = close_requested.clone();
        let running = handle.queue.clone();
        window.on_window_should_close(cx, move |_, _| {
            if running.lock().unwrap().running {
                closed.store(true, Ordering::SeqCst);
                false
            } else {
                true
            }
        });
        let state = handle.state.lock().unwrap().clone();
        let mut this = Self {
            handle,
            state,
            queue: Queue::default(),
            drafts: HashMap::new(),
            repository: cx.new(|cx| TextInput::new("", "owner/repository or GitHub URL", cx)),
            dialog: None,
            activity: false,
            launch_remaining: vec![],
            launch_ids: vec![],
            local_error: None,
            close_requested,
            last_refresh: Instant::now(),
            focus: cx.focus_handle(),
        };
        this.sync(cx);
        cx.spawn(async move |entity, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(200))
                    .await;
                if entity
                    .update(cx, |this, cx| {
                        this.sync(cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        this
    }
    fn active(&self) -> Option<&Workspace> {
        self.state.config.active()
    }
    fn draft(&self) -> Option<&Draft> {
        self.active().and_then(|w| self.drafts.get(&w.id))
    }
    fn draft_mut(&mut self) -> Option<&mut Draft> {
        let id = self.state.config.active_workspace_id.clone()?;
        self.drafts.get_mut(&id)
    }
    fn blocked(&self) -> bool {
        self.state.busy || self.queue.running
    }
    fn sync(&mut self, cx: &mut Context<Self>) {
        self.state = self.handle.state.lock().unwrap().clone();
        self.queue = self.handle.queue.lock().unwrap().clone();
        for w in &self.state.config.workspaces {
            let branch = w
                .branch
                .as_ref()
                .or_else(|| self.state.defaults.get(&w.id))
                .cloned()
                .unwrap_or_default();
            let draft = self.drafts.entry(w.id.clone()).or_insert_with(|| Draft {
                branch: cx.new(|cx| TextInput::new(&branch, "Branch", cx)),
                search: cx.new(|cx| TextInput::new("", "Find a workflow...", cx)),
                selected: vec![],
                multiple: false,
                filter: 0,
                sort: 0,
                inputs: HashMap::new(),
            });
            if draft.branch.read(cx).value().is_empty() && !branch.is_empty() {
                draft.branch.update(cx, |input, cx| input.set(&branch, cx));
            }
            if let Some(rows) = self.state.workflows.get(&w.id) {
                draft
                    .selected
                    .retain(|id| rows.iter().any(|r| r.id == *id && r.state == "active"));
            }
        }
        for item in &self.queue.items {
            if let Some(run) = &item.run
                && let Some(rows) = self.state.workflows.get_mut(&self.queue.workspace_id)
                && let Some(row) = rows.iter_mut().find(|w| w.id == item.workflow_id)
                && row
                    .last_run
                    .as_ref()
                    .is_none_or(|old| old.updated_at <= run.updated_at)
            {
                row.last_run = Some(run.clone());
            }
        }
        if let Some(Dialog::Loading(id, branch, launching)) = &self.dialog
            && let Some(reply) = &self.state.schema
            && Some(&reply.workspace) == self.state.config.active_workspace_id.as_ref()
            && reply.workflow == *id
            && reply.branch == *branch
            && !self.state.busy
        {
            let draft = self
                .draft()
                .and_then(|d| d.inputs.get(&(*id, branch.clone())));
            let fields = reply
                .schema
                .inputs
                .iter()
                .map(|i| {
                    let value = draft.and_then(|v| v.get(&i.name)).unwrap_or(&i.default);
                    let text = match value {
                        Value::Null => String::new(),
                        Value::String(v) => v.clone(),
                        _ => value.to_string(),
                    };
                    cx.new(|cx| {
                        TextInput::new(&text, if i.required { "Required" } else { "Optional" }, cx)
                    })
                })
                .collect();
            self.dialog = Some(Dialog::Inputs(Form {
                workflow: *id,
                branch: branch.clone(),
                schema: reply.schema.clone(),
                fields,
                launching: *launching,
            }));
        }
        if self.close_requested.swap(false, Ordering::SeqCst) {
            self.dialog = Some(Dialog::Quit);
        }
        if self.last_refresh.elapsed() >= Duration::from_secs(5)
            && !self.state.busy
            && self.dialog.is_none()
        {
            if let Some(w) = self.active() {
                self.handle.send(Command::Refresh(w.id.clone(), false));
            }
            self.last_refresh = Instant::now();
        }
    }
    fn request_inputs(&mut self, id: u64, launching: bool, cx: &mut Context<Self>) {
        if let (Some(w), Some(d)) = (self.active(), self.draft()) {
            let branch = d.branch.read(cx).value();
            self.handle.state.lock().unwrap().schema = None;
            self.handle
                .send(Command::Inputs(w.id.clone(), id, branch.clone()));
            self.dialog = Some(Dialog::Loading(id, branch, launching));
        }
    }
    fn begin_launch(&mut self, ids: Vec<u64>, cx: &mut Context<Self>) {
        if self.blocked() || ids.is_empty() {
            return;
        }
        self.launch_ids = ids.clone();
        self.launch_remaining = ids;
        self.next_form(cx);
    }
    fn next_form(&mut self, cx: &mut Context<Self>) {
        if !self.launch_remaining.is_empty() {
            let id = self.launch_remaining.remove(0);
            self.request_inputs(id, true, cx);
        } else if let (Some(w), Some(d)) = (self.active(), self.draft()) {
            let branch = d.branch.read(cx).value();
            let inputs = self
                .launch_ids
                .iter()
                .filter_map(|id| {
                    d.inputs
                        .get(&(*id, branch.clone()))
                        .map(|v| (*id, v.clone()))
                })
                .collect();
            self.handle.send(Command::Run {
                workspace: w.id.clone(),
                ids: self.launch_ids.clone(),
                branch,
                multiple: self.launch_ids.len() > 1 && d.multiple,
                inputs,
            });
            self.dialog = None;
        }
    }
    fn act(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        self.local_error = None;
        match action {
            Action::Connect => {
                self.dialog = Some(Dialog::Connect);
                window.focus(&self.repository.focus_handle(cx), cx);
            }
            Action::Settings => self.dialog = Some(Dialog::Settings),
            Action::Close => {
                self.dialog = None;
                self.launch_remaining.clear();
                self.launch_ids.clear();
                window.focus(&self.focus, cx);
            }
            Action::Add => {
                if !self.blocked() {
                    self.handle
                        .send(Command::Add(self.repository.read(cx).value()));
                    self.dialog = None;
                }
            }
            Action::Switch(id) => {
                if !self.state.busy {
                    self.handle.send(Command::Select(id));
                }
            }
            Action::Remove(id) => self.dialog = Some(Dialog::Remove(id)),
            Action::ConfirmRemove(id) => {
                self.handle.send(Command::Remove(id));
                self.dialog = None;
            }
            Action::Refresh => {
                if let Some(w) = self.active() {
                    self.handle.send(Command::Refresh(w.id.clone(), true));
                }
            }
            Action::SaveBranch => {
                if let (Some(w), Some(d)) = (self.active(), self.draft()) {
                    self.handle
                        .send(Command::Branch(w.id.clone(), d.branch.read(cx).value()));
                }
            }
            Action::Multiple => {
                if !self.blocked()
                    && let Some(d) = self.draft_mut()
                {
                    d.multiple = !d.multiple;
                    if !d.multiple {
                        d.selected.truncate(1);
                    }
                }
            }
            Action::Select(id) => {
                if !self.blocked()
                    && let Some(d) = self.draft_mut()
                {
                    if d.selected.contains(&id) {
                        d.selected.retain(|i| *i != id);
                    } else {
                        if !d.multiple {
                            d.selected.clear();
                        }
                        d.selected.push(id);
                    }
                }
            }
            Action::Play(id) => self.begin_launch(vec![id], cx),
            Action::Options(id) => {
                if !self.blocked() {
                    self.request_inputs(id, false, cx);
                }
            }
            Action::Move(i, up) => {
                if !self.blocked()
                    && let Some(d) = self.draft_mut()
                {
                    let target = if up {
                        i.saturating_sub(1)
                    } else {
                        (i + 1).min(d.selected.len().saturating_sub(1))
                    };
                    if i < d.selected.len() {
                        d.selected.swap(i, target);
                    }
                }
            }
            Action::Drop(id) => {
                if !self.blocked()
                    && let Some(d) = self.draft_mut()
                {
                    d.selected.retain(|i| *i != id);
                }
            }
            Action::Clear => {
                if !self.blocked()
                    && let Some(d) = self.draft_mut()
                {
                    d.selected.clear();
                }
            }
            Action::Launch => {
                let ids = self.draft().map(|d| d.selected.clone()).unwrap_or_default();
                self.begin_launch(ids, cx);
            }
            Action::SaveInputs => {
                if let Some(Dialog::Inputs(form)) = &self.dialog {
                    let values: Map<_, _> = form
                        .schema
                        .inputs
                        .iter()
                        .zip(&form.fields)
                        .map(|(i, field)| (i.name.clone(), Value::String(field.read(cx).value())))
                        .collect();
                    match validate_inputs(&form.schema, &values) {
                        Ok(values) => {
                            let id = form.workflow;
                            let branch = form.branch.clone();
                            let launching = form.launching;
                            if let Some(d) = self.draft_mut() {
                                d.inputs.insert((id, branch), values);
                            }
                            if launching {
                                self.next_form(cx);
                            } else {
                                self.dialog = None;
                            }
                        }
                        Err(error) => self.local_error = Some(error.to_string()),
                    }
                }
            }
            Action::Stop => self.handle.request_stop(),
            Action::Activity(value) => self.activity = value,
            Action::Filter => {
                if let Some(d) = self.draft_mut() {
                    d.filter = (d.filter + 1) % 6;
                }
            }
            Action::Sort => {
                if let Some(d) = self.draft_mut() {
                    d.sort = (d.sort + 1) % 3;
                }
            }
            Action::Open(value) => {
                if let Some(url) = safe_url(&value) {
                    cx.open_url(&url);
                }
            }
            Action::Dismiss => {
                self.handle.state.lock().unwrap().error = None;
            }
            Action::Quit => {
                if self.queue.running {
                    self.dialog = Some(Dialog::Quit);
                } else {
                    cx.quit();
                }
            }
            Action::ConfirmQuit => {
                self.handle.request_stop();
                cx.quit();
            }
        }
        self.sync(cx);
        cx.notify();
    }
    fn control(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        action: Action,
        enabled: bool,
        primary: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let keyboard = action.clone();
        div()
            .id(id)
            .px_3()
            .py_2()
            .rounded_md()
            .border_1()
            .border_color(rgb(if primary { GREEN } else { LINE }))
            .bg(rgb(if primary { GREEN } else { 0xffffff }))
            .text_color(rgb(if primary { 0xffffff } else { INK }))
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .focusable()
            .tab_index(0)
            .tab_stop(enabled)
            .when(!enabled, |d| d.opacity(0.4).cursor_default())
            .focus(|s| s.border_color(rgb(0x328dff)))
            .when(enabled, |d| {
                d.hover(|s| s.bg(rgb(if primary { 0x005e4c } else { 0xf0f5f2 })))
            })
            .child(label.into())
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                if enabled {
                    this.act(action.clone(), window, cx);
                }
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if enabled && (event.keystroke.key == "enter" || event.keystroke.key == "space") {
                    cx.stop_propagation();
                    this.act(keyboard.clone(), window, cx);
                }
            }))
    }
    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.state.config.active_workspace_id.as_deref();
        div()
            .w(px(216.))
            .flex_shrink_0()
            .h_full()
            .bg(rgb(0xfcfdfc))
            .border_r_1()
            .border_color(rgb(LINE))
            .p_5()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_size(px(26.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(rgb(GREEN))
                    .mt_3()
                    .mb_8()
                    .child("dispatch"),
            )
            .child(eyebrow("WORKSPACES"))
            .child(
                div()
                    .id("workspaces")
                    .max_h(px(280.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .children(self.state.config.workspaces.iter().map(|w| {
                        self.control(
                            SharedString::from(format!("workspace-{}", w.id)),
                            w.repository.clone(),
                            Action::Switch(w.id.clone()),
                            !self.state.busy,
                            active == Some(&w.id),
                            cx,
                        )
                        .w_full()
                        .overflow_hidden()
                    })),
            )
            .child(self.control(
                "add-workspace",
                "+ Add workspace",
                Action::Connect,
                !self.blocked(),
                false,
                cx,
            ))
            .child(div().h_5())
            .child(self.control(
                "nav-workflows",
                "Workflows",
                Action::Activity(false),
                true,
                !self.activity,
                cx,
            ))
            .child(self.control(
                "nav-activity",
                "Latest activity",
                Action::Activity(true),
                true,
                self.activity,
                cx,
            ))
            .child(div().flex_1())
            .child(
                div()
                    .border_t_1()
                    .border_color(rgb(LINE))
                    .pt_5()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Running on your machine"),
                    )
                    .child(muted(
                        "Credentials stay on this device. Workflows run on GitHub.",
                    ))
                    .child(self.control(
                        "settings",
                        "Workspace settings",
                        Action::Settings,
                        !self.state.busy,
                        false,
                        cx,
                    ))
                    .child(self.control("quit", "Quit Dispatch", Action::Quit, true, false, cx)),
            )
    }
    fn workflows(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(w) = self.active() else {
            return div().into_any_element();
        };
        let Some(d) = self.draft() else {
            return div().into_any_element();
        };
        let query = d.search.read(cx).value().trim().to_lowercase();
        let all = self.state.workflows.get(&w.id).cloned().unwrap_or_default();
        let mut rows: Vec<_> = all
            .iter()
            .filter(|row| {
                let recency = recency(row.last_run.as_ref(), chrono::Utc::now());
                let filter = [
                    None,
                    Some(Recency::Hour),
                    Some(Recency::Day),
                    Some(Recency::Week),
                    Some(Recency::Stale),
                    Some(Recency::Never),
                ][d.filter];
                format!("{} {}", row.name, row.path)
                    .to_lowercase()
                    .contains(&query)
                    && filter.is_none_or(|f| f == recency)
                    && (!self.activity || row.last_run.is_some())
            })
            .cloned()
            .collect();
        let sort = if self.activity { 1 } else { d.sort };
        rows.sort_by(|a, b| {
            let names = a.name.to_lowercase().cmp(&b.name.to_lowercase());
            match sort {
                1 => b
                    .last_run
                    .as_ref()
                    .map(Run::started)
                    .cmp(&a.last_run.as_ref().map(Run::started))
                    .then(names),
                2 => a
                    .last_run
                    .as_ref()
                    .map(Run::started)
                    .cmp(&b.last_run.as_ref().map(Run::started))
                    .then(names),
                _ => names,
            }
        });
        let count = rows.len();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap_4()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                        "{}   {}",
                        if self.activity {
                            "Latest activity"
                        } else {
                            "Workflows"
                        },
                        all.len()
                    )))
                    .child(self.control(
                        "repo-link",
                        "View on GitHub",
                        Action::Open(format!("https://github.com/{}/actions", w.repository)),
                        true,
                        false,
                        cx,
                    )),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(d.search.clone()))
                    .child(self.control(
                        "filter",
                        [
                            "All last runs",
                            "< 12 hours",
                            "12–24 hours",
                            "1–7 days",
                            "> 7 days",
                            "Never run",
                        ][d.filter],
                        Action::Filter,
                        true,
                        false,
                        cx,
                    ))
                    .child(self.control(
                        "sort",
                        ["Name A–Z", "Newest first", "Oldest first"][d.sort],
                        Action::Sort,
                        !self.activity,
                        false,
                        cx,
                    )),
            )
            .child(
                div()
                    .id("workflow-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .border_1()
                    .border_color(rgb(LINE))
                    .rounded_lg()
                    .bg(rgb(0xffffff))
                    .child(
                        div()
                            .flex()
                            .px_4()
                            .py_3()
                            .bg(rgb(0xfafcfb))
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .child(div().flex_1().child("WORKFLOW"))
                            .child(div().w(px(130.)).child("LAST RUN"))
                            .child(div().w(px(115.)).child("RESULT")),
                    )
                    .when(rows.is_empty(), |el| {
                        el.child(div().p_8().child(if self.state.busy {
                            "Loading workflows..."
                        } else if all.is_empty() {
                            "No workflows found in this repository."
                        } else {
                            "No workflows match these filters."
                        }))
                    })
                    .children(rows.into_iter().map(|row| {
                        let id = row.id;
                        let selected = d.selected.contains(&id);
                        let enabled = row.state == "active" && !self.blocked();
                        let run = row.last_run.as_ref();
                        let color = recency_color(recency(run, chrono::Utc::now()));
                        let meta = run
                            .map(|r| {
                                format!(
                                    "{} · {}m {}s",
                                    r.head_branch.as_deref().unwrap_or(""),
                                    r.duration() / 60,
                                    r.duration() % 60
                                )
                            })
                            .unwrap_or_else(|| "No run history".into());
                        let run_url = run.and_then(|r| safe_url(&r.html_url));
                        div()
                            .id(("row", id))
                            .flex()
                            .items_center()
                            .gap_3()
                            .px_4()
                            .py_5()
                            .border_t_1()
                            .border_color(rgb(LINE))
                            .bg(rgb(if selected { 0xeff7f3 } else { 0xffffff }))
                            .child(self.control(
                                ("select", id),
                                if selected { "✓" } else { "  " },
                                Action::Select(id),
                                enabled,
                                selected,
                                cx,
                            ))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(
                                        div()
                                            .text_color(rgb(color))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(row.name),
                                    )
                                    .child(div().text_size(px(11.)).text_color(rgb(MUTED)).child(
                                        row.path.rsplit('/').next().unwrap_or(&row.path).to_owned(),
                                    ))
                                    .when(row.state != "active", |d| {
                                        d.child(muted(format!("Inactive: {}", row.state)))
                                    }),
                            )
                            .child(
                                div()
                                    .w(px(130.))
                                    .flex_shrink_0()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .child(self.control(
                                        ("run-url", id),
                                        relative_time(run),
                                        Action::Open(run_url.clone().unwrap_or_default()),
                                        run_url.is_some(),
                                        false,
                                        cx,
                                    ))
                                    .child(muted(meta)),
                            )
                            .child(
                                div()
                                    .w(px(90.))
                                    .flex_shrink_0()
                                    .child(badge(run.map(Run::result).unwrap_or("No runs"))),
                            )
                            .child(self.control(
                                ("play", id),
                                "Run",
                                Action::Play(id),
                                enabled,
                                false,
                                cx,
                            ))
                    })),
            )
            .child(muted(format!("{count} of {} workflows", all.len())))
            .child(
                div()
                    .border_t_1()
                    .border_color(rgb(LINE))
                    .pt_3()
                    .child(muted(
                        "Name colors show recency: green <12h · yellow <24h · gray 1–7d · red >7d",
                    )),
            )
            .into_any_element()
    }
    fn queue_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let d = self.draft();
        let blocked = self.blocked();
        let selected = d.map(|d| d.selected.clone()).unwrap_or_default();
        let rows = self.active().and_then(|w| self.state.workflows.get(&w.id));
        let own = self
            .active()
            .is_some_and(|w| w.id == self.queue.workspace_id);
        div().w(px(300.)).flex_shrink_0().flex().flex_col().gap_4().border_1().border_color(rgb(LINE)).rounded_lg().bg(rgb(0xffffff)).p_5()
            .child(div().font_weight(FontWeight::SEMIBOLD).child("Run queue"))
            .child(self.control("multiple", if d.is_some_and(|d| d.multiple) { "✓ Allow multiple workflows" } else { "□ Allow multiple workflows" }, Action::Multiple, !blocked, false, cx))
            .child(muted("Selection order is execution order."))
            .child(eyebrow("RUN ON BRANCH"))
            .when_some(d, |el,d| el.child(d.branch.clone()))
            .child(self.control("save-branch", "Save branch", Action::SaveBranch, !blocked, false, cx))
            .child(div().border_t_1().border_color(rgb(LINE)).pt_4().flex().justify_between().items_center().child(eyebrow("UP NEXT"))
                .child(self.control("clear", "Clear", Action::Clear, !blocked && !selected.is_empty(), false, cx)))
            .child(div().id("selection").flex_1().min_h(px(70.)).overflow_y_scroll().flex().flex_col().gap_3()
                .when(selected.is_empty(), |d| d.child(muted("Select a workflow to get started.")))
                .children(selected.iter().enumerate().map(|(i,id)| {
                    let name = rows.and_then(|rows| rows.iter().find(|w| w.id == *id)).map(|w| w.name.clone()).unwrap_or_default();
                    div().flex().flex_col().gap_2().child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).child(format!("{}. {name}", i+1)))
                        .child(div().flex().gap_1()
                            .child(self.control(("up",*id), "↑", Action::Move(i,true), !blocked && i > 0,false,cx))
                            .child(self.control(("down",*id), "↓", Action::Move(i,false), !blocked && i+1 < selected.len(),false,cx))
                            .child(self.control(("drop",*id), "×", Action::Drop(*id), !blocked,false,cx))
                            .child(self.control(("options",*id), "Options", Action::Options(*id), !blocked,false,cx)))
                })))
            .when(own && !self.queue.items.is_empty(), |el| el.child(div().id("execution").max_h(px(220.)).overflow_y_scroll().flex().flex_col().gap_2()
                .child(eyebrow("EXECUTION"))
                .children(self.queue.items.iter().enumerate().map(|(i,item)| div().flex().flex_col().gap_1()
                    .child(muted(item.name.clone()))
                    .child(self.control(("execution-run",i), item.run.as_ref().map(|r| format!("{} · {}",item.status,r.result())).unwrap_or_else(|| item.status.clone()),
                        Action::Open(item.run.as_ref().map(|r| r.html_url.clone()).unwrap_or_default()),item.run.as_ref().and_then(|r| safe_url(&r.html_url)).is_some(),false,cx)))))
            )
            .when_some(if own { self.queue.error.as_ref() } else { None }, |d,error| d.child(div().text_size(px(12.)).text_color(rgb(0xb33939)).child(error.clone())))
            .child(self.control("launch", if self.state.busy { "Preparing..." } else if self.queue.running { "Queue running" } else if selected.len() > 1 { "Run sequentially" } else { "Run workflow" }, Action::Launch, !blocked && !selected.is_empty(), true,cx))
            .when(self.queue.running, |d| d.child(self.control("stop", if self.handle.stop.load(Ordering::SeqCst) { "Stopping after current..." } else { "Stop after current workflow" },Action::Stop,!self.handle.stop.load(Ordering::SeqCst),false,cx)))
            .child(muted("One at a time, across workspaces. A failure stops the queue. Keep Dispatch open while monitoring."))
    }
    fn modal(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(dialog) = &self.dialog else {
            return div().into_any_element();
        };
        let mut content = div()
            .id("dialog-content")
            .flex()
            .flex_col()
            .gap_4()
            .max_h(px(600.))
            .overflow_y_scroll();
        match dialog {
            Dialog::Connect => {
                content = content.child(title("Connect a repository"))
                    .child(muted("Use GitHub CLI authentication or set GH_TOKEN / GITHUB_TOKEN before opening Dispatch."))
                    .child(self.repository.clone())
                    .child(self.control("connect", "Connect repository", Action::Add, !self.blocked(),true,cx));
            }
            Dialog::Settings => {
                content = content
                    .child(title("Workspace settings"))
                    .child(muted("Removing a workspace only changes local settings."))
                    .children(self.state.config.workspaces.iter().map(|w| {
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .gap_3()
                            .child(w.repository.clone())
                            .child(self.control(
                                SharedString::from(format!("remove-{}", w.id)),
                                "Remove",
                                Action::Remove(w.id.clone()),
                                !self.blocked(),
                                false,
                                cx,
                            ))
                    }));
            }
            Dialog::Remove(id) => {
                let name = self
                    .state
                    .config
                    .workspaces
                    .iter()
                    .find(|w| &w.id == id)
                    .map(|w| w.repository.as_str())
                    .unwrap_or("this workspace");
                content = content.child(title("Remove workspace?"))
                    .child(muted(format!("Remove {name} from local settings. Its GitHub repository and workflows will remain available.")))
                    .child(self.control("confirm-remove","Remove workspace",Action::ConfirmRemove(id.clone()),!self.blocked(),true,cx));
            }
            Dialog::Loading(_, _, _) => {
                content = content.child(title("Preparing run options")).child(muted(
                    if self.state.busy {
                        "Reading workflow inputs from the selected branch..."
                    } else {
                        "Could not load run options. Close this dialog to try again."
                    },
                ));
            }
            Dialog::Inputs(form) => {
                let name = self
                    .active()
                    .and_then(|w| self.state.workflows.get(&w.id))
                    .and_then(|rows| rows.iter().find(|w| w.id == form.workflow))
                    .map(|w| w.name.clone())
                    .unwrap_or_default();
                content = content
                    .child(title(name))
                    .child(muted(format!("Run options on {}", form.branch)))
                    .when(form.schema.inputs.is_empty(), |d| {
                        d.child(muted("This workflow has no inputs."))
                    })
                    .children(form.schema.inputs.iter().zip(&form.fields).enumerate().map(
                        |(index, (input, field))| {
                            let choices: Vec<_> = match input.kind {
                                InputType::Boolean => vec!["true".into(), "false".into()],
                                InputType::Choice => input.options.clone(),
                                _ => vec![],
                            };
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .child(div().font_weight(FontWeight::MEDIUM).child(format!(
                                    "{}{}",
                                    input.name,
                                    if input.required { " *" } else { "" }
                                )))
                                .when(!input.description.is_empty(), |d| {
                                    d.child(muted(input.description.clone()))
                                })
                                .child(field.clone())
                                .when(!choices.is_empty(), |d| {
                                    d.child(div().flex().flex_wrap().gap_1().children(
                                        choices.into_iter().enumerate().map(
                                            |(choice_index, choice)| {
                                                let field = field.clone();
                                                let value = choice.clone();
                                                div()
                                                    .id(("choice", index * 1000 + choice_index))
                                                    .px_2()
                                                    .py_1()
                                                    .rounded_md()
                                                    .bg(rgb(0xeef5f1))
                                                    .text_size(px(12.))
                                                    .cursor_pointer()
                                                    .child(choice)
                                                    .on_click(cx.listener(move |_, _, _, cx| {
                                                        field.update(cx, |field, cx| {
                                                            field.set(&value, cx)
                                                        });
                                                        cx.notify();
                                                    }))
                                            },
                                        ),
                                    ))
                                })
                        },
                    ))
                    .child(self.control(
                        "save-inputs",
                        if form.launching {
                            if self.launch_remaining.is_empty() {
                                "Run workflow queue"
                            } else {
                                "Next workflow"
                            }
                        } else {
                            "Save options"
                        },
                        Action::SaveInputs,
                        !self.state.busy,
                        true,
                        cx,
                    ));
            }
            Dialog::Quit => {
                content = content.child(title("Quit with a queue running?"))
                    .child(muted("Dispatch will stop monitoring and discard pending items. A workflow already dispatched will continue on GitHub. Queues are never resumed automatically."))
                    .child(self.control("confirm-quit","Quit Dispatch",Action::ConfirmQuit,true,true,cx));
            }
        }
        if let Some(error) = self.local_error.as_ref().or(self.state.error.as_ref()) {
            content = content.child(
                div()
                    .text_color(rgb(0xb33939))
                    .text_size(px(13.))
                    .child(error.clone()),
            );
        }
        div()
            .absolute()
            .inset_0()
            .occlude()
            .bg(rgba(0x152a2055))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .w(px(560.))
                    .max_h(px(730.))
                    .p_6()
                    .rounded_xl()
                    .shadow_lg()
                    .border_1()
                    .border_color(rgb(LINE))
                    .bg(rgb(0xffffff))
                    .flex()
                    .flex_col()
                    .gap_5()
                    .child(content)
                    .child(self.control(
                        "close-dialog",
                        "Cancel / close",
                        Action::Close,
                        true,
                        false,
                        cx,
                    )),
            )
            .into_any_element()
    }
}
impl Render for Dispatch {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let configured = self.active().is_some();
        let repo = self
            .active()
            .map(|w| w.repository.clone())
            .unwrap_or_else(|| "No repository connected".into());
        let other = self.queue.running
            && self
                .active()
                .is_none_or(|w| w.id != self.queue.workspace_id);
        div().size_full().relative().flex().font_family("sans-serif").text_size(px(14.)).text_color(rgb(INK)).bg(rgb(0xf5f7f6))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this,event: &KeyDownEvent,window,cx| {
                if event.keystroke.key == "escape" && this.dialog.is_some() { this.act(Action::Close,window,cx); }
            }))
            .child(self.sidebar(cx))
            .child(div().flex_1().min_w_0().h_full().flex().flex_col()
                .child(div().h(px(64.)).flex_shrink_0().px_7().flex().items_center().justify_between().bg(rgb(0xfcfdfc)).border_b_1().border_color(rgb(LINE))
                    .child(format!("{repo}   /   {}",if self.activity { "Latest activity" } else { "Workflows" }))
                    .child(muted(format!("Native desktop · {}",if self.state.auth == "none" { "No GitHub credentials" } else { "GitHub authenticated" }))))
                .child(div().p_7().flex_1().min_h_0().flex().flex_col().gap_5()
                    .child(div().flex().justify_between().items_center()
                        .child(div().flex().flex_col().gap_2().child(eyebrow("GITHUB ACTIONS, WITHOUT THE EXTRA CLICKS"))
                            .child(title(if !configured { "Connect your repository." } else if self.activity { "The latest, at a glance." } else { "Your workflows. Ready to run." }))
                            .child(muted("Pick a workflow, or line up a few. They run one at a time.")))
                        .when(configured, |d|d.child(self.control("refresh","Refresh",Action::Refresh,!self.state.busy,false,cx))))
                    .when_some(self.state.error.as_ref(), |d,error|d.child(div().flex().items_center().gap_3().p_3().rounded_md().bg(rgb(0xffeeee)).text_color(rgb(0xb33939))
                        .child(div().flex_1().child(error.clone())).child(self.control("dismiss","Dismiss",Action::Dismiss,true,false,cx))))
                    .when_some(self.state.notice.as_ref(),|d,notice|d.child(muted(notice.clone())))
                    .when(other, |d|d.child(self.control("running-elsewhere",format!("{} has a running queue. View queue",self.queue.repository),Action::Switch(self.queue.workspace_id.clone()),!self.state.busy,false,cx)))
                    .child(if configured {
                        div().flex().gap_6().flex_1().min_h_0().child(self.workflows(cx)).child(self.queue_panel(cx)).into_any_element()
                    } else {
                        div().flex_1().flex().flex_col().items_center().justify_center().gap_5()
                            .child(div().text_size(px(48.)).text_color(rgb(GREEN)).child("↗"))
                            .child(title("Your workflows belong here."))
                            .child(muted("Connect a GitHub repository to load its workflows and latest runs."))
                            .child(self.control("setup-connect","Connect a repository",Action::Connect,!self.state.busy,true,cx)).into_any_element()
                    })
                    .child(muted(if self.state.busy { "Syncing with GitHub..." } else { "Local desktop app · Metadata refreshes automatically · Credentials are never saved in settings" }))))
            .when(self.dialog.is_some(), |d|d.child(self.modal(cx)))
    }
}
fn muted(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(11.))
        .text_color(rgb(MUTED))
        .child(value.into())
}
fn eyebrow(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(10.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(MUTED))
        .child(value.into())
}
fn title(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(26.))
        .font_weight(FontWeight::BOLD)
        .child(value.into())
}
fn recency_color(recency: Recency) -> u32 {
    match recency {
        Recency::Hour => 0x087c50,
        Recency::Day => 0x99730a,
        Recency::Week => 0x53615b,
        Recency::Stale => 0xbc3939,
        Recency::Never => 0x85908a,
    }
}
fn badge(result: &str) -> Div {
    let (color, bg) = match result {
        "success" => (0x197450, 0xeaf4ee),
        "failure" | "cancelled" | "timed_out" | "action_required" => (0xb33939, 0xffeeee),
        "queued" | "waiting" | "in_progress" | "pending" => (0x94690b, 0xfff5dc),
        _ => (MUTED, 0xf0f3f1),
    };
    div()
        .px_2()
        .py_1()
        .rounded_sm()
        .bg(rgb(bg))
        .text_color(rgb(color))
        .text_size(px(10.))
        .child(result.to_owned())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use dispatch_rs::{config::Config, service::SchemaReply};

    #[::core::prelude::v1::test]
    fn native_headless_views_inputs_and_queue_controls() {
        let rows: Vec<_> = [1, 2, 3]
            .into_iter()
            .map(|id| Workflow {
                id,
                name: format!("Workflow {id}"),
                path: format!(".github/workflows/{id}.yml"),
                state: "active".into(),
                last_run: None,
            })
            .collect();
        let config = Config {
            active_workspace_id: Some("alpha".into()),
            workspaces: vec![
                Workspace {
                    id: "alpha".into(),
                    repository: "acme/alpha".into(),
                    branch: Some("main".into()),
                },
                Workspace {
                    id: "beta".into(),
                    repository: "acme/beta".into(),
                    branch: Some("release".into()),
                },
            ],
            ..Config::default()
        };
        let (backend, commands) = Handle::channel(Snapshot {
            config,
            workflows: HashMap::from([("alpha".into(), rows.clone()), ("beta".into(), rows)]),
            auth: "fake".into(),
            ..Snapshot::default()
        });
        gpui_platform::headless().run(move |cx| {
            crate::input::bind_keys(cx);
            let window = cx.open_window(WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(0.),px(0.)),size(px(1400.),px(900.))))), ..WindowOptions::default()
            }, |window,cx| cx.new(|cx| Dispatch::new(backend.clone(),window,cx))).unwrap();
            let draw = |cx: &mut App| {
                let token = cx.update_window(window.into(), |_,window,cx| window.draw(cx)).unwrap();
                token.clear(cx);
            };
            draw(cx);
            window.update(cx, |view,window,cx| {
                view.act(Action::Select(1),window,cx); view.act(Action::Select(2),window,cx);
                assert_eq!(view.draft().unwrap().selected,vec![2]);
                view.act(Action::Multiple,window,cx); view.act(Action::Select(1),window,cx);
                view.act(Action::Move(1,true),window,cx); assert_eq!(view.draft().unwrap().selected,vec![1,2]);
                view.draft().unwrap().search.update(cx,|field,cx|field.set("Workflow",cx));
                backend.state.lock().unwrap().config.active_workspace_id = Some("beta".into()); view.sync(cx);
                assert!(view.draft().unwrap().selected.is_empty()); assert_eq!(view.draft().unwrap().branch.read(cx).value(),"release");
                backend.state.lock().unwrap().config.active_workspace_id = Some("alpha".into()); view.sync(cx);
                assert_eq!(view.draft().unwrap().selected,vec![1,2]); assert_eq!(view.draft().unwrap().search.read(cx).value(),"Workflow");
                view.act(Action::Activity(true),window,cx);
            }).unwrap();
            draw(cx);
            for action in [Action::Settings,Action::Connect,Action::Remove("alpha".into()),Action::Close] {
                window.update(cx,|view,window,cx|view.act(action,window,cx)).unwrap(); draw(cx);
            }
            window.update(cx, |view,window,cx| {
                view.act(Action::Launch,window,cx);
                assert!(matches!(commands.try_recv().unwrap(),Command::Inputs(_,1,_)));
                let schema = parse_schema("on:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: choice\n        options: [staging, production]\n        default: staging").unwrap();
                { let mut state = backend.state.lock().unwrap(); state.busy = false; state.schema = Some(SchemaReply {workspace:"alpha".into(),branch:"main".into(),workflow:1,schema}); }
                view.sync(cx); assert!(matches!(view.dialog,Some(Dialog::Inputs(_))));
            }).unwrap();
            draw(cx);
            window.update(cx, |view,window,cx| {
                view.act(Action::SaveInputs,window,cx);
                assert!(matches!(commands.try_recv().unwrap(),Command::Inputs(_,2,_)));
                { let mut state = backend.state.lock().unwrap(); state.busy = false; state.schema = Some(SchemaReply {workspace:"alpha".into(),branch:"main".into(),workflow:2,schema:Schema { dispatchable:true,inputs:vec![] }}); }
                view.sync(cx); view.act(Action::SaveInputs,window,cx);
                match commands.try_recv().unwrap() {
                    Command::Run {ids,multiple,inputs,..} => {assert_eq!(ids,vec![1,2]);assert!(multiple);assert_eq!(inputs[&1]["target"],"staging");}
                    _ => panic!("Expected a queue command"),
                }
                backend.state.lock().unwrap().busy = false;
                { let mut queue = backend.queue.lock().unwrap();queue.running = true;queue.workspace_id = "alpha".into(); }
                view.sync(cx); view.act(Action::Quit,window,cx); assert!(matches!(view.dialog,Some(Dialog::Quit)));
                view.act(Action::Stop,window,cx); assert!(backend.stop.load(Ordering::SeqCst));
            }).unwrap();
            draw(cx);
            window.update(cx,|view,_,cx| {
                backend.queue.lock().unwrap().running = false;
                backend.state.lock().unwrap().config = Config::default(); view.dialog = None; view.sync(cx);
            }).unwrap();
            draw(cx);
            // The Linux event loop resets an early stop flag when run() begins.
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_millis(1)).await;
                cx.update(|cx| cx.quit());
            }).detach();
        });
    }
}
