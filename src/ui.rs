use crate::input::TextInput;
use dispatch_rs::{
    config::Workspace,
    model::*,
    runner::{Queue, QueueItem},
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

const GREEN: u32 = 0x006b58;
const INK: u32 = 0x252c32;
const MUTED: u32 = 0x606970;
const LINE: u32 = 0xdce1e3;

#[derive(Clone)]
enum Action {
    Connect,
    WorkspacePicker,
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
    Workspaces,
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
    dialog_focus: FocusHandle,
}
impl Dispatch {
    pub fn new(handle: Handle, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::assets::load_fonts(cx);
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
            dialog_focus: cx.focus_handle(),
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
                branch: cx.new(|cx| TextInput::branch(&branch, cx)),
                search: cx.new(TextInput::search),
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
            let skip_empty_form = *launching && reply.schema.inputs.is_empty();
            self.dialog = Some(Dialog::Inputs(Form {
                workflow: *id,
                branch: branch.clone(),
                schema: reply.schema.clone(),
                fields,
                launching: *launching,
            }));
            if skip_empty_form {
                self.next_form(cx);
            }
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
            Action::WorkspacePicker => self.dialog = Some(Dialog::Workspaces),
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
                self.dialog = None;
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
    fn button(
        &self,
        id: impl Into<ElementId>,
        action: Action,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let keyboard = action.clone();
        div()
            .id(id)
            .flex()
            .items_center()
            .flex_shrink_0()
            .cursor_pointer()
            .focusable()
            .tab_index(0)
            .tab_stop(enabled)
            .when(!enabled, |d| d.opacity(0.45).cursor_default())
            .focus(|s| s.border_color(rgb(GREEN)))
            .role(Role::Button)
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
    fn control(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        action: Action,
        enabled: bool,
        primary: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.button(id, action, enabled, cx)
            .h(px(40.))
            .px(px(12.))
            .gap(px(8.))
            .rounded(px(6.))
            .border_1()
            .border_color(rgb(if primary { GREEN } else { 0xabb6b3 }))
            .bg(rgb(if primary { GREEN } else { 0xffffff }))
            .text_color(rgb(if primary { 0xffffff } else { INK }))
            .text_size(px(13.))
            .font_weight(FontWeight::SEMIBOLD)
            .whitespace_nowrap()
            .when(enabled, |d| {
                d.hover(|s| s.bg(rgb(if primary { 0x005546 } else { 0xedf2ef })))
            })
            .child(label.into())
    }
    fn link(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        action: Action,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.button(id, action, enabled, cx)
            .h(px(24.))
            .gap(px(6.))
            .text_size(px(12.))
            .text_color(rgb(GREEN))
            .hover(|s| s.text_color(rgb(0x004b3e)))
            .child(label.into())
    }
    fn icon_button(
        &self,
        id: impl Into<ElementId>,
        name: &'static str,
        label: impl Into<SharedString>,
        action: Action,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.button(id, action, enabled, cx)
            .aria_label(label)
            .size(px(32.))
            .justify_center()
            .rounded(px(5.))
            .border_1()
            .border_color(rgb(0xbdc7c2))
            .bg(rgb(0xffffff))
            .text_color(rgb(0x65756b))
            .when(enabled, |d| {
                d.hover(|s| {
                    s.bg(rgb(0xe7f2ec))
                        .border_color(rgb(0x588f76))
                        .text_color(rgb(GREEN))
                })
            })
            .child(icon(name, 13.))
    }
    fn checkbox(
        &self,
        id: impl Into<ElementId>,
        action: Action,
        checked: bool,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.button(id, action, enabled, cx)
            .size(px(18.))
            .justify_center()
            .rounded(px(2.))
            .border_1()
            .border_color(rgb(if checked { GREEN } else { 0x89928c }))
            .bg(rgb(if checked { GREEN } else { 0xffffff }))
            .text_color(rgb(0xffffff))
            .aria_label(if checked {
                "Selected"
            } else {
                "Select workflow"
            })
            .role(Role::CheckBox)
            .when(checked, |d| {
                d.child(icon("check", 15.).text_color(rgb(0xffffff)))
            })
    }
    fn sidebar(&self, compact: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let count = self
            .active()
            .and_then(|w| self.state.workflows.get(&w.id))
            .map_or(0, Vec::len);
        let repo = self
            .active()
            .map(|w| w.repository.clone())
            .unwrap_or_else(|| "Connect a repository".into());
        div()
            .w(px(if compact { 200. } else { 232. }))
            .h_full()
            .flex_shrink_0()
            .bg(rgb(0xfcfcfc))
            .border_r_1()
            .border_color(rgb(LINE))
            .px(px(if compact { 16. } else { 20. }))
            // .py(px(32.))
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(36.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_size(px(if compact { 21. } else { 24. }))
                            .text_color(rgb(0x1e2927))
                            .child("dispatch"),
                    ),
            )
            .child(
                div()
                    // .mt(px(24.))
                    // .mt(px(48.))
                    .mb(px(12.))
                    .px(px(8.))
                    .child(eyebrow("W O R K S P A C E S")),
            )
            .child(
                self.button(
                    "workspace-picker",
                    Action::WorkspacePicker,
                    !self.state.busy,
                    cx,
                )
                .h(px(44.))
                .w_full()
                .px(px(12.))
                .gap(px(8.))
                .border_1()
                .border_color(rgb(0x89969b))
                .rounded(px(6.))
                .bg(rgb(0xffffff))
                .text_size(px(12.))
                .child(div().flex_1().min_w_0().truncate().child(repo))
                .child(icon("chevron", 12.)),
            )
            .child(
                self.link(
                    "add-workspace",
                    "+ Add workspace",
                    Action::Connect,
                    !self.blocked(),
                    cx,
                )
                .h(px(32.))
                .mt(px(8.))
                .px(px(4.))
                .font_weight(FontWeight::SEMIBOLD),
            )
            .child(
                div().mt(px(28.)).flex().flex_col().gap(px(8.)).children(
                    [
                        (false, "workflow", "Workflows"),
                        (true, "clock", "Latest activity"),
                    ]
                    .into_iter()
                    .map(|(activity, name, label)| {
                        let active = self.activity == activity;
                        self.button(
                            if activity {
                                "nav-activity"
                            } else {
                                "nav-workflows"
                            },
                            Action::Activity(activity),
                            true,
                            cx,
                        )
                        .h(px(44.))
                        .px(px(12.))
                        .gap(px(14.))
                        .rounded(px(6.))
                        .bg(rgb(if active { 0xecf2ee } else { 0xfcfcfc }))
                        .text_color(rgb(if active { GREEN } else { 0x606970 }))
                        .font_weight(if active {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::NORMAL
                        })
                        .hover(|s| s.bg(rgb(0xecf2ee)))
                        .child(icon(name, 18.).text_color(rgb(if active { GREEN } else { MUTED })))
                        .child(label)
                        .when(!activity, |d| {
                            d.child(
                                div()
                                    .ml_auto()
                                    .rounded(px(4.))
                                    .px(px(6.))
                                    .py(px(2.))
                                    .text_size(px(12.))
                                    .bg(rgb(0xd9e9e1))
                                    .child(count.to_string()),
                            )
                        })
                    }),
                ),
            )
            .child(div().flex_1().min_h(px(24.)))
            .child(
                div()
                    .border_t_1()
                    .border_color(rgb(LINE))
                    .pt(px(24.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .mb(px(12.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::BOLD)
                            .child(dot(0x20835c, 7.))
                            .child("Running on your machine"),
                    )
                    .child(muted("Credentials stay on this device.").mb(px(4.)))
                    .child(muted("Your workflows stay on GitHub."))
                    .child(
                        self.button("settings", Action::Settings, !self.state.busy, cx)
                            .h(px(40.))
                            .mt(px(20.))
                            .gap(px(10.))
                            .text_color(rgb(0x606e68))
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(icon("settings", 15.))
                            .child("Workspace settings"),
                    )
                    .child(
                        self.link("quit", "Quit Dispatch", Action::Quit, true, cx)
                            .text_size(px(10.))
                            .mb(px(20.))
                            .text_color(rgb(MUTED)),
                    ),
            )
    }
    fn workflows(&self, compact: bool, cx: &mut Context<Self>) -> AnyElement {
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
                    && filter
                        .is_none_or(|f| f == recency(row.last_run.as_ref(), chrono::Utc::now()))
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
        let last_width = if compact { 108. } else { 125. };
        let result_width = if compact { 90. } else { 104. };
        let run_width = if compact { 48. } else { 58. };
        let cell_padding = if compact { 10. } else { 16. };
        div().flex().flex_col().flex_1().min_w_0()
            .child(div().h(px(27.)).mb(px(20.)).flex().items_center().justify_between()
                .child(div().flex().items_center().gap(px(10.)).text_size(px(18.)).font_weight(FontWeight::BOLD)
                    .child(if self.activity { "Latest activity" } else { "Workflows" })
                    .child(count_badge(all.len(), false)))
                .child(self.link("repo-link", "View on GitHub ↗", Action::Open(format!("https://github.com/{}/actions",w.repository)), true,cx).text_color(rgb(0x5f6966))))
            .child(div().flex().gap(px(12.)).mb(px(16.))
                .child(div().flex_1().min_w_0().child(d.search.clone()))
                .child(self.button("filter", Action::Filter,true,cx).w(px(if compact { 125. } else { 145. })).h(px(44.)).px(px(12.)).gap(px(8.)).border_1().border_color(rgb(0xb9c4c0)).rounded(px(6.)).bg(rgb(0xffffff)).text_size(px(12.))
                    .child(div().flex_1().child(["All last runs","< 12 hours","12–24 hours","1–7 days","> 7 days","Never run"][d.filter])).child(icon("chevron",12.))))
            .child(div().id("workflow-list").border_1().border_color(rgb(LINE)).rounded(px(8.)).overflow_hidden().bg(rgb(0xffffff))
                .child(div().h(px(41.)).flex().items_center().bg(rgb(0xfcfdfc)).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x66716b))
                    .child(div().w(px(44.)).flex_shrink_0())
                    .child(div().flex_1().min_w_0().px(px(cell_padding)).child("Workflow"))
                    .child(div().w(px(last_width)).flex_shrink_0().px(px(cell_padding)).child("Last run"))
                    .child(div().w(px(result_width)).flex_shrink_0().px(px(cell_padding)).child("Result"))
                    .child(div().w(px(run_width)).flex_shrink_0()))
                .when(rows.is_empty(), |el| el.child(div().p(px(32.)).text_color(rgb(MUTED)).child(if self.state.busy { "Loading workflows..." } else if all.is_empty() { "No workflows found in this repository." } else { "No workflows match these filters." })))
                .children(rows.into_iter().map(|row| {
                    let id = row.id; let selected = d.selected.contains(&id); let enabled = row.state == "active" && !self.blocked(); let run = row.last_run.as_ref();
                    let meta = run.map(|r| format!("{} · {}", r.head_branch.as_deref().unwrap_or(""), duration(r.duration()))).unwrap_or_else(|| "No run history".into());
                    let run_url = run.and_then(|r| safe_url(&r.html_url));
                    div().id(("row",id)).min_h(px(88.)).flex().items_center().border_t_1().border_color(rgb(0xe9eceb))
                        .bg(rgb(if selected { 0xf0f7f3 } else { 0xffffff })).hover(|s| s.bg(rgb(if selected { 0xf0f7f3 } else { 0xfafcfb })))
                        .child(div().w(px(44.)).flex_shrink_0().flex().items_center().justify_center().child(self.checkbox(("select",id),Action::Select(id),selected,enabled,cx).aria_label(format!("Select {}",row.name))))
                        .child(div().flex_1().min_w_0().px(px(cell_padding)).py(px(18.)).flex().flex_col().gap(px(4.))
                            .child(div().text_size(px(if compact { 13. } else { 14. })).font_weight(FontWeight::SEMIBOLD).line_height(px(21.)).text_color(rgb(recency_color(recency(run,chrono::Utc::now())))).child(row.name.clone()))
                            .child(div().font_family(crate::assets::MONO_FONT).text_size(px(10.)).line_height(px(15.)).text_color(rgb(0x626e66)).truncate().child(row.path.rsplit('/').next().unwrap_or(&row.path).to_owned()))
                            .when(row.state != "active",|d|d.child(muted(format!("Inactive: {}",row.state)))))
                        .child(div().w(px(last_width)).flex_shrink_0().px(px(cell_padding)).flex().flex_col().gap(px(4.))
                            .child(self.link(("run-url",id),run_time(run),Action::Open(run_url.clone().unwrap_or_default()),run_url.is_some(),cx)
                                .h(px(16.)).text_color(rgb(0x414d47)).font_weight(FontWeight::NORMAL).when(run.is_none(),|d|d.opacity(1.)))
                            .child(div().text_size(px(10.)).line_height(px(15.)).text_color(rgb(0x657168)).truncate().child(meta)))
                        .child(div().w(px(result_width)).flex_shrink_0().px(px(cell_padding)).flex().items_center().child(badge(run.map(Run::result).unwrap_or("No runs"))))
                        .child(div().w(px(run_width)).flex_shrink_0().flex().justify_center().child(self.icon_button(("play",id),"play",format!("Run {}",row.name),Action::Play(id),enabled,cx)))
                })))
            .child(div().h(px(64.)).flex().items_center().justify_between().text_size(px(11.)).text_color(rgb(0x65716a))
                .child(format!("{count} of {} workflows",all.len()))
                .child(div().flex().items_center().gap(px(8.)).child("Sort by")
                    .child(self.link("sort",["Name A–Z","Newest first","Oldest first"][d.sort],Action::Sort,!self.activity,cx).text_size(px(11.)).text_color(rgb(0x424f48)).child(icon("chevron",12.)))))
            .child(div().border_t_1().border_color(rgb(LINE)).py(px(20.)).flex().flex_wrap().items_center().gap(px(12.))
                .child(div().text_size(px(9.)).font_weight(FontWeight::BOLD).text_color(rgb(0x64716a)).child("L A S T  R U N"))
                .children([(Recency::Hour,"< 12 hours"),(Recency::Day,"12–24 hours"),(Recency::Week,"1–7 days"),(Recency::Stale,"> 7 days"),(Recency::Never,"Never run")].into_iter().map(|(recency,label)|
                    div().flex().items_center().gap(px(6.)).text_size(px(10.)).text_color(rgb(0x64716a))
                        .child(dot(recency_color(recency),6.).when(recency == Recency::Never,|d|d.bg(rgb(0xf6f7f8)).border_1().border_color(rgb(0x7b858b)))).child(label))))
            .child(div().py(px(12.)).flex().items_center().gap(px(8.)).text_size(px(11.)).text_color(rgb(0x69746e)).child(icon("info",15.)).child("Name colors show when a workflow last ran, not whether it passed. The result is shown separately."))
            .into_any_element()
    }
    fn queue_panel(&self, compact: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let d = self.draft();
        let blocked = self.blocked();
        let rows = self.active().and_then(|w| self.state.workflows.get(&w.id));
        let own = self
            .active()
            .is_some_and(|w| w.id == self.queue.workspace_id);
        let selected = if own && self.queue.running && !self.queue.items.is_empty() {
            self.queue
                .items
                .iter()
                .map(|item| item.workflow_id)
                .collect()
        } else {
            d.map(|d| d.selected.clone()).unwrap_or_default()
        };
        let padding = if compact { 16. } else { 20. };
        let branch = d.map(|d| d.branch.read(cx).value()).unwrap_or_default();
        let saved = self
            .active()
            .and_then(|w| w.branch.as_ref().or_else(|| self.state.defaults.get(&w.id)))
            .map(String::as_str)
            .unwrap_or("");
        div().w(px(if compact { 280. } else { 304. })).flex_shrink_0().rounded(px(10.)).border_1().border_color(rgb(0xd4dcd8)).bg(rgb(0xffffff)).overflow_hidden().flex().flex_col()
            .child(div().h(px(64.)).px(px(padding)).flex().items_center().justify_between().border_b_1().border_color(rgb(LINE))
                .child(div().text_size(px(16.)).font_weight(FontWeight::BOLD).child("Run queue")).child(count_badge(selected.len(),true)))
            .child(div().p(px(padding)).border_b_1().border_color(rgb(LINE)).flex().flex_col()
                .child(self.button("multiple",Action::Multiple,!blocked,cx).h(px(32.)).gap(px(8.)).text_size(px(13.)).font_weight(FontWeight::SEMIBOLD)
                    .child(div().size(px(18.)).flex_shrink_0().rounded(px(2.)).border_1().border_color(rgb(0x89928c)).bg(rgb(if d.is_some_and(|d|d.multiple) { GREEN } else { 0xffffff })).text_color(rgb(0xffffff)).flex().items_center().justify_center()
                        .when(d.is_some_and(|d|d.multiple),|d|d.child(icon("check",15.).text_color(rgb(0xffffff)))))
                    .child("Allow multiple workflows"))
                .child(muted(if d.is_some_and(|d|d.multiple) { "Selected workflows still run one at a time." } else { "Off by default. Select one workflow at a time." }).mt(px(4.)).mb(px(24.)).line_height(px(18.)))
                .child(div().mb(px(8.)).h(px(16.)).flex().items_center().gap(px(6.)).text_size(px(11.)).text_color(rgb(0x5f6c64))
                    .child(icon("branch",14.)).child("Run on branch")
                    .when(branch != saved,|d|d.child(self.link("save-branch","Save",Action::SaveBranch,!blocked,cx).ml_auto().text_size(px(10.)))))
                .when_some(d,|el,d|el.child(d.branch.clone()))
                .child(div().mt(px(8.)).text_size(px(10.)).line_height(px(16.)).text_color(rgb(0x5f6c64)).child("Saved per workspace.")))
            .child(div().px(px(padding)).pt(px(padding)).pb(px(20.)).min_h(px(212.)).flex().flex_col()
                .child(div().h(px(24.)).flex().items_center().justify_between()
                    .child(div().text_size(px(9.)).font_weight(FontWeight::BOLD).text_color(rgb(0x637168)).child("UP NEXT · SELECTION ORDER"))
                    .child(self.link("clear","Clear",Action::Clear,!blocked && !selected.is_empty(),cx).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD)))
                .when(selected.is_empty(),|d|d.child(div().py(px(24.)).flex().flex_col().items_center().gap(px(10.)).text_size(px(12.)).text_color(rgb(0x506158))
                    .child(icon("queue",32.)).child("Select a workflow to get started.")))
                .children(selected.iter().enumerate().map(|(i,id)| {
                    let execution = if own {
                        self.queue.items.iter().find(|item| item.workflow_id == *id && (self.queue.running || item.branch == branch))
                    } else { None };
                    let name = rows.and_then(|rows|rows.iter().find(|w|w.id == *id)).map(|w|w.name.clone())
                        .or_else(||execution.map(|item|item.name.clone())).unwrap_or_default();
                    let detail = if let Some(item) = execution {
                        let status = execution_status(item);
                        let color = match status.as_str() {
                            "Passed" => 0x27684b,
                            "Failed" | "Cancelled" | "Timed out" | "Needs action" => 0x9c3935,
                            "Running" | "Starting" | "Queued" | "Waiting" => 0x2e6487,
                            _ => 0x617167,
                        };
                        let url = item.run.as_ref().and_then(|run| safe_url(&run.html_url));
                        self.link(("execution-run",*id),status,Action::Open(url.clone().unwrap_or_default()),url.is_some(),cx)
                            .mt(px(3.)).h(px(15.)).text_size(px(10.)).line_height(px(15.)).text_color(rgb(color))
                            .when(url.is_none(),|d|d.opacity(1.)).into_any_element()
                    } else {
                        div().mt(px(3.)).text_size(px(10.)).line_height(px(15.)).text_color(rgb(0x617167))
                            .child(if i == 0 { "Starts first" } else { "After the previous workflow succeeds" }).into_any_element()
                    };
                    div().mt(px(if i == 0 { 24. } else { 12. })).flex().items_start().gap(px(10.))
                        .child(div().size(px(24.)).flex_shrink_0().flex().items_center().justify_center().rounded_full().bg(rgb(0xeff4f0)).border_1().border_color(rgb(0xd8e3dc)).text_size(px(11.)).text_color(rgb(0x5d7164)).child((i+1).to_string()))
                        .child(div().flex_1().min_w_0().flex().flex_col()
                            .child(div().font_weight(FontWeight::SEMIBOLD).text_size(px(12.)).line_height(px(18.)).child(name))
                            .child(detail)
                            .child(div().mt(px(6.)).flex().items_center().gap(px(2.))
                                .child(self.icon_button(("up",*id),"up","Move up",Action::Move(i,true),!blocked && i > 0,cx).size(px(24.)))
                                .child(self.icon_button(("down",*id),"down","Move down",Action::Move(i,false),!blocked && i+1 < selected.len(),cx).size(px(24.)))
                                .child(self.icon_button(("drop",*id),"cross","Remove from selection",Action::Drop(*id),!blocked,cx).size(px(24.)))
                                .child(self.control(("options",*id),"Run options",Action::Options(*id),!blocked,false,cx).h(px(24.)).px(px(6.)).text_size(px(10.)).font_weight(FontWeight::NORMAL))))
                })))
            .when_some(if own { self.queue.error.as_ref() } else { None },|d,error|d.child(div().px(px(padding)).pb(px(12.)).text_size(px(12.)).text_color(rgb(0xb33939)).child(error.clone())))
            .child(div().px(px(padding)).pb(px(padding)).flex().flex_col()
                .child(self.button("launch",Action::Launch,!blocked && !selected.is_empty(),cx).h(px(44.)).px(px(16.)).gap(px(8.)).rounded(px(6.)).bg(rgb(GREEN)).text_color(rgb(0xffffff)).font_weight(FontWeight::SEMIBOLD).text_size(px(13.))
                    .when(blocked || selected.is_empty(),|d|d.opacity(1.).bg(rgb(0xe4ece7)).text_color(rgb(0x687b6e)))
                    .child(icon("play",14.).text_color(rgb(0xffffff))).child(if self.state.busy { "Preparing..." } else if self.queue.running { "Queue running" } else if selected.len() > 1 { "Run workflows" } else { "Run workflow" })
                    .child(div().ml_auto().opacity(0.7).child(icon("return",14.).text_color(rgb(0xffffff)))))
                .child(div().mt(px(10.)).flex().justify_center().text_size(px(10.)).line_height(px(16.)).text_color(rgb(0x69796d)).child(if branch.is_empty() { "Choose a branch to run on.".into() } else { format!("Runs on {branch}.") }))
                .when(self.queue.running,|d|d.child(self.control("stop",if self.handle.stop.load(Ordering::SeqCst) { "Stopping after current..." } else { "Stop after current workflow" },Action::Stop,!self.handle.stop.load(Ordering::SeqCst),false,cx).mt(px(12.)).text_size(px(11.)))))
            .child(div().border_t_1().border_color(rgb(LINE)).bg(rgb(0xf8faf8)).p(px(padding)).flex().items_start().gap(px(8.)).text_color(rgb(0x698372))
                .child(icon("shield",14.)).child(div().flex_1().min_w_0().text_size(px(10.)).line_height(px(18.)).text_color(rgb(0x596e5f))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("One at a time. Across workspaces."))
                    .child("Each workflow finishes before the next starts. A failure stops the queue.")))
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
            Dialog::Workspaces => {
                content = content.child(title("Choose a workspace")).children(
                    self.state.config.workspaces.iter().map(|workspace| {
                        self.control(
                            SharedString::from(format!("choose-{}", workspace.id)),
                            workspace.repository.clone(),
                            Action::Switch(workspace.id.clone()),
                            !self.state.busy,
                            self.state.config.active_workspace_id.as_deref() == Some(&workspace.id),
                            cx,
                        )
                    }),
                );
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
            .track_focus(&self.dialog_focus)
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let compact = window.viewport_size().width < px(1200.);
        let padding = if compact { 24. } else { 40. };
        let configured = self.active().is_some();
        let repo = self
            .active()
            .map(|w| w.repository.clone())
            .unwrap_or_else(|| "No repository connected".into());
        let other = self.queue.running
            && self
                .active()
                .is_none_or(|w| w.id != self.queue.workspace_id);
        let page = if self.activity {
            "Latest activity"
        } else {
            "Workflows"
        };
        div().id("dispatch-app").size_full().relative().flex().font_family(crate::assets::UI_FONT)
            .text_size(px(14.)).line_height(rems(1.5)).text_color(rgb(INK)).bg(rgb(0xf6f7f8))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this,event: &KeyDownEvent,window,cx| {
                if event.keystroke.key == "escape" && this.dialog.is_some() { this.act(Action::Close,window,cx); }
                if event.keystroke.key == "enter" && this.dialog.is_none() {
                    let editing = this.draft().is_some_and(|draft| draft.branch.focus_handle(cx).is_focused(window) || draft.search.focus_handle(cx).is_focused(window));
                    if !editing { cx.stop_propagation(); this.act(Action::Launch,window,cx); }
                }
                if event.keystroke.key == "tab" {
                    window.prevent_default(); cx.stop_propagation();
                    for _ in 0..1024 {
                        if event.keystroke.modifiers.shift { window.focus_prev(cx); } else { window.focus_next(cx); }
                        if this.dialog.is_none() || this.dialog_focus.contains_focused(window,cx) { break; }
                    }
                }
            }))
            .child(self.sidebar(compact,cx))
            .child(div().flex_1().min_w_0().h_full().flex().flex_col()
                .child(div().h(px(64.)).flex_shrink_0().px(px(padding)).flex().items_center().justify_between().gap(px(16.)).bg(rgb(0xfcfcfc)).border_b_1().border_color(rgb(LINE))
                    .child(div().flex_1().flex().items_center().gap(px(12.)).min_w_0().text_size(px(13.))
                        .child(icon("github",18.)).child(div().truncate().child(repo)).child(div().text_color(rgb(0x9ba4a8)).child("/"))
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(page)))
                    .child(div().flex_shrink_0().flex().items_center().gap(px(12.))
                        .child(div().flex().items_center().gap(px(8.)).rounded_full().border_1().border_color(rgb(LINE)).bg(rgb(0xffffff)).px(px(10.)).py(px(5.)).text_size(px(12.))
                            .child(dot(if matches!(self.state.auth.as_str(),"gh"|"environment"|"fake") { 0x20835c } else { 0x7b858b },7.))
                            .child(if matches!(self.state.auth.as_str(),"gh"|"environment"|"fake") { "GitHub connected" } else { "Not authenticated" }))
                        .when(configured,|d|d.child(self.button("refresh",Action::Refresh,!self.state.busy,cx).h(px(36.)).px(px(12.)).gap(px(8.)).border_1().border_color(rgb(0xabb6b3)).rounded(px(6.)).bg(rgb(0xffffff)).text_size(px(13.)).font_weight(FontWeight::SEMIBOLD)
                            .child(icon("refresh",16.)).child("Refresh")))))
                .child(div().id("page-scroll").flex_1().min_h_0().overflow_y_scroll()
                    .child(div().px(px(padding)).pt(px(24.)).pb(px(24.)).flex().flex_col()
                        .when_some(self.state.error.as_ref(),|d,error|d.child(div().flex().items_center().gap(px(16.)).p(px(14.)).mb(px(24.)).rounded(px(6.)).border_1().border_color(rgb(0xd3a4a3)).bg(rgb(0xfff1f0)).text_color(rgb(0x942f2e))
                            .child(div().flex_1().min_w_0().child(error.clone())).child(self.link("dismiss","Dismiss",Action::Dismiss,true,cx))))
                        .when_some(self.state.notice.as_ref(),|d,notice|d.child(muted(notice.clone()).mb(px(16.))))
                        .when(other,|d|d.child(self.control("running-elsewhere",format!("{} has a running queue. View queue",self.queue.repository),Action::Switch(self.queue.workspace_id.clone()),!self.state.busy,false,cx).mb(px(24.))))
                        .child(if configured {
                            div().flex().items_start().gap(px(if compact { 20. } else { 32. })).child(self.workflows(compact,cx)).child(self.queue_panel(compact,cx)).into_any_element()
                        } else {
                            div().min_h(px(320.)).p(px(40.)).border_1().border_color(rgb(LINE)).rounded(px(8.)).bg(rgb(0xffffff)).flex().flex_col().items_start().gap(px(16.))
                                .child(div().text_color(rgb(GREEN)).child(icon("workflow",32.)))
                                .child(title("Your workflows belong here.").text_size(px(24.)))
                                .child(muted("Connect a GitHub repository to load its workflows and latest runs.").text_size(px(14.)))
                                .child(self.control("setup-connect","Connect a repository",Action::Connect,!self.state.busy,true,cx)).into_any_element()
                        })
                        .child(div().mt(px(48.)).pt(px(20.)).border_t_1().border_color(rgb(LINE)).flex().items_center().justify_between().gap(px(16.)).text_color(rgb(0x606e64)).text_size(px(10.))
                            .child(div().flex().items_center().gap(px(8.)).child(dot(0x20835c,5.)).child(if self.state.busy { "Syncing with GitHub..." } else { "Auto-refresh every 5s · Running on your machine" }))
                            .child("Less tab-hopping. More shipping.")))))
            .when(self.dialog.is_some(),|d|d.child(self.modal(cx)))
    }
}
fn icon(name: &'static str, size: f32) -> Svg {
    svg()
        .text_color(rgb(MUTED))
        .path(SharedString::from(format!("icons/{name}.svg")))
        .size(px(size))
        .flex_shrink_0()
}
fn dot(color: u32, diameter: f32) -> Div {
    div()
        .size(px(diameter))
        .flex_shrink_0()
        .rounded_full()
        .bg(rgb(color))
}
fn count_badge(count: usize, circle: bool) -> Div {
    div()
        .min_w(px(23.))
        .h(px(24.))
        .px(px(6.))
        .flex()
        .items_center()
        .justify_center()
        .border_1()
        .border_color(rgb(0xdce3df))
        .bg(rgb(0xebefed))
        .rounded(px(if circle { 20. } else { 4. }))
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(0x5f6c64))
        .child(count.to_string())
}
fn muted(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(11.))
        .line_height(px(17.))
        .text_color(rgb(MUTED))
        .child(value.into())
}
fn eyebrow(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(11.))
        .line_height(px(16.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(MUTED))
        .child(value.into())
}
fn title(value: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(32.))
        .line_height(px(38.))
        .font_weight(FontWeight::BOLD)
        .child(value.into())
}
fn recency_color(recency: Recency) -> u32 {
    match recency {
        Recency::Hour => 0x15724f,
        Recency::Day => 0x886207,
        Recency::Week => 0x55616c,
        Recency::Stale => 0xb43a38,
        Recency::Never => 0x626c74,
    }
}
fn run_time(run: Option<&Run>) -> String {
    let Some(run) = run else {
        return "Never run".into();
    };
    let seconds = (chrono::Utc::now() - run.started()).num_seconds().max(0);
    if seconds < 60 {
        return "Just now".into();
    }
    let (amount, unit) = if seconds < 3600 {
        (seconds / 60, "minute")
    } else if seconds < 86400 {
        (seconds / 3600, "hour")
    } else {
        (seconds / 86400, "day")
    };
    format!("{amount} {unit}{} ago", if amount == 1 { "" } else { "s" })
}
fn duration(seconds: i64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}
fn execution_status(item: &QueueItem) -> String {
    let status = if item.status == "failed" {
        "failure"
    } else {
        item.run.as_ref().map(Run::result).unwrap_or(&item.status)
    };
    match status {
        "in_progress" | "in progress" => "Running".into(),
        "success" => "Passed".into(),
        "failure" => "Failed".into(),
        "pending" => "Pending".into(),
        "queued" => "Queued".into(),
        "waiting" => "Waiting".into(),
        "waiting for repository" => "Waiting for existing runs".into(),
        "dispatching" => "Starting".into(),
        "completed" => "Completed".into(),
        "skipped" => "Skipped".into(),
        "cancelled" => "Cancelled".into(),
        "timed_out" => "Timed out".into(),
        "action_required" => "Needs action".into(),
        _ => status.replace('_', " "),
    }
}
fn badge(result: &str) -> Div {
    let (color, bg, name, label) = match result {
        "success" => (0x27684b, 0xedf5f0, "check", "Passed"),
        "failure" => (0x9c3935, 0xfff0ed, "cross", "Failed"),
        "cancelled" => (0x9c3935, 0xfff0ed, "clock", "Cancelled"),
        "timed_out" => (0x9c3935, 0xfff0ed, "clock", "Timed out"),
        "action_required" => (0x9c3935, 0xfff0ed, "clock", "Needs action"),
        "in_progress" => (0x2e6487, 0xedf4fa, "clock", "Running"),
        "queued" => (0x2e6487, 0xedf4fa, "clock", "Queued"),
        "waiting" | "pending" => (0x2e6487, 0xedf4fa, "clock", "Waiting"),
        "No runs" => (0x656e69, 0xf0f2f1, "", "—"),
        _ => (0x656e69, 0xf0f2f1, "clock", result),
    };
    div()
        .flex()
        .items_center()
        .flex_shrink_0()
        .gap(px(4.))
        .px(px(6.))
        .py(px(4.))
        .rounded(px(4.))
        .bg(rgb(bg))
        .text_color(rgb(color))
        .text_size(px(10.))
        .line_height(px(14.))
        .whitespace_nowrap()
        .when(!name.is_empty(), |d| d.child(icon(name, 12.)))
        .child(label.to_owned())
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
        gpui_platform::headless().with_assets(crate::assets::Assets).run(move |cx| {
            crate::input::bind_keys(cx);
            let window = cx.open_window(WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(0.),px(0.)),size(px(1400.),px(900.))))), ..WindowOptions::default()
            }, |window,cx| cx.new(|cx| Dispatch::new(backend.clone(),window,cx))).unwrap();
            let draw = |cx: &mut App| {
                let token = cx.update_window(window.into(), |_,window,cx| window.draw(cx)).unwrap();
                token.clear(cx);
            };
            draw(cx);
            window.update(cx, |_,window,cx| {
                let field = cx.new(|cx| TextInput::new("😀x", "", cx));
                field.update(cx, |field,cx| {
                    field.replace_and_mark_text_in_range(Some(2..3), "é", Some(0..1), window, cx);
                    assert_eq!(field.value(), "😀é");
                    assert_eq!(field.selected_text_range(false,window,cx).unwrap().range,2..3);
                    field.replace_text_in_range(None,"z",window,cx);
                    assert_eq!(field.value(), "😀z");
                });
            }).unwrap();
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

#[cfg(all(test, feature = "visual-tests", target_os = "linux"))]
mod visual_tests {
    use super::*;
    use dispatch_rs::config::Config;

    #[::core::prelude::v1::test]
    #[ignore = "Renders offscreen previews with a real GPU or software Vulkan adapter"]
    fn render_desktop_previews() {
        let output = std::env::var_os("DISPATCH_PREVIEW_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("dispatch-previews"));
        std::fs::create_dir_all(&output).unwrap();
        let platform = gpui_platform::current_platform(true);
        let mut cx = HeadlessAppContext::with_platform(
            platform.text_system(),
            Arc::new(crate::assets::Assets),
            gpui_platform::current_headless_renderer,
        );
        let now = chrono::Utc::now();
        let rows: Vec<_> = [
            ("CI pipeline", "ci.yml", Some(600), "success"),
            (
                "Database migrations",
                "migrations.yml",
                Some(86400),
                "failure",
            ),
            (
                "Deploy production",
                "deploy-production.yml",
                Some(18000),
                "success",
            ),
            (
                "Deploy staging",
                "deploy-staging.yml",
                Some(2700),
                "success",
            ),
            ("Docs preview", "docs.yml", None, ""),
            ("End-to-end tests", "e2e.yml", Some(3600), "failure"),
            ("Release package", "release.yml", Some(777600), "cancelled"),
            ("Security audit", "security.yml", Some(7200), "success"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (name, path, age, result))| Workflow {
            id: index as u64 + 1,
            name: name.into(),
            path: format!(".github/workflows/{path}"),
            state: "active".into(),
            last_run: age.map(|age| Run {
                id: index as u64 + 100,
                workflow_id: index as u64 + 1,
                status: "completed".into(),
                conclusion: Some(result.into()),
                created_at: now - chrono::Duration::seconds(age),
                updated_at: now - chrono::Duration::seconds(age),
                head_branch: Some("main".into()),
                html_url: format!(
                    "https://github.com/test-org/workflows/actions/runs/{}",
                    index + 100
                ),
                ..Run::default()
            }),
        })
        .collect();
        for (width, height, name) in [
            (1440., 1373., "desktop-full"),
            (1440., 900., "desktop"),
            (1105., 877., "compact"),
        ] {
            let config = Config {
                active_workspace_id: Some("sample".into()),
                workspaces: vec![Workspace {
                    id: "sample".into(),
                    repository: "test-org/workflows".into(),
                    branch: Some("main".into()),
                }],
                ..Config::default()
            };
            let (backend, _commands) = Handle::channel(Snapshot {
                config,
                workflows: HashMap::from([("sample".into(), rows.clone())]),
                auth: "fake".into(),
                ..Snapshot::default()
            });
            let window = cx
                .open_window(size(px(width), px(height)), |window, cx| {
                    cx.new(|cx| Dispatch::new(backend, window, cx))
                })
                .unwrap();
            window
                .update(&mut cx, |view, _, _| {
                    view.draft_mut().unwrap().selected = vec![1]
                })
                .unwrap();
            for _ in 0..3 {
                cx.update(|cx| {
                    let token = cx
                        .update_window(window.into(), |_, window, cx| window.draw(cx))
                        .unwrap();
                    token.clear(cx);
                });
                cx.run_until_parked();
            }
            cx.capture_screenshot(window.into())
                .unwrap()
                .save(output.join(format!("{name}.png")))
                .unwrap();
        }
    }
}
