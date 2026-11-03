use crate::{
    config::{Config, Store, Workspace},
    github::{ClientGitHub, GitHub},
    model::*,
    runner::{self, Queue, QueueItem, Timing},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Instant,
};

#[derive(Clone, Debug)]
pub struct SchemaReply {
    pub workspace: String,
    pub branch: String,
    pub workflow: u64,
    pub schema: Schema,
}
#[derive(Clone, Default)]
pub struct Snapshot {
    pub config: Config,
    pub workflows: HashMap<String, Vec<Workflow>>,
    pub defaults: HashMap<String, String>,
    pub busy: bool,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub schema: Option<SchemaReply>,
    pub auth: String,
    pub revision: u64,
}
pub enum Command {
    Add(String),
    Select(String),
    Remove(String),
    Branch(String, String),
    Refresh(String, bool),
    Inputs(String, u64, String),
    Run {
        workspace: String,
        ids: Vec<u64>,
        branch: String,
        multiple: bool,
        inputs: HashMap<u64, Map<String, Value>>,
    },
}
#[derive(Clone)]
pub struct Handle {
    pub state: Arc<Mutex<Snapshot>>,
    pub queue: Arc<Mutex<Queue>>,
    pub stop: Arc<AtomicBool>,
    sender: mpsc::Sender<Command>,
}
impl Handle {
    pub fn launch() -> Result<Self> {
        let store = Store::open(Store::default_path()?)?;
        let directory = std::env::current_dir()?;
        let local_legacy = directory.join(".data/config.json");
        let legacy = if !local_legacy.exists() && directory.file_name().is_some_and(|name| name == "dispatch-rs") {
            directory.parent().unwrap_or(&directory).join(".data/config.json")
        } else { local_legacy };
        let config = store.load(Some(&legacy), std::env::var("GITHUB_REPO").ok().as_deref())?;
        let (handle, receiver) = Self::channel(Snapshot {
            config,
            busy: true,
            ..Snapshot::default()
        });
        let worker_handle = handle.clone();
        std::thread::spawn(move || {
            let result = ClientGitHub::new();
            let api = match result {
                Ok(api) => Arc::new(api),
                Err(error) => {
                    let mut state = worker_handle.state.lock().unwrap();
                    state.error = Some(error.to_string());
                    state.busy = false;
                    return;
                }
            };
            worker_handle.state.lock().unwrap().auth = api.auth_source().into();
            let mut worker = Worker {
                handle: worker_handle,
                store,
                api,
                refreshed: HashMap::new(),
            };
            let initial = worker
                .handle
                .state
                .lock()
                .unwrap()
                .config
                .active_workspace_id
                .clone();
            let result = initial.map(|id| worker.refresh(&id, true)).transpose();
            worker.finish(result.map(|_| ()));
            while let Ok(command) = receiver.recv() {
                let result = worker.process(command);
                worker.finish(result);
            }
        });
        Ok(handle)
    }
    /// Build the UI/backend message bridge with an initial snapshot.
    pub fn channel(snapshot: Snapshot) -> (Self, mpsc::Receiver<Command>) {
        let (sender, receiver) = mpsc::channel();
        (
            Self {
                state: Arc::new(Mutex::new(snapshot)),
                queue: Arc::default(),
                stop: Arc::default(),
                sender,
            },
            receiver,
        )
    }
    pub fn send(&self, command: Command) {
        let mut state = self.state.lock().unwrap();
        if state.busy {
            return;
        }
        state.busy = true;
        state.error = None;
        state.notice = None;
        if self.sender.send(command).is_err() {
            state.busy = false;
            state.error = Some("The background worker stopped. Restart Dispatch.".into());
        }
    }
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}
struct Worker {
    handle: Handle,
    store: Store,
    api: Arc<ClientGitHub>,
    refreshed: HashMap<String, Instant>,
}
impl Worker {
    fn finish(&self, result: Result<()>) {
        let mut state = self.handle.state.lock().unwrap();
        state.busy = false;
        state.revision += 1;
        if let Err(error) = result {
            state.error = Some(error.to_string());
        }
    }
    fn config(&self) -> Config {
        self.handle.state.lock().unwrap().config.clone()
    }
    fn workspace(&self, id: &str) -> Result<Workspace> {
        self.config()
            .workspaces
            .into_iter()
            .find(|w| w.id == id)
            .context("Workspace not found.")
    }
    fn commit(&self, config: Config) -> Result<()> {
        self.store.save(&config)?;
        self.handle.state.lock().unwrap().config = config;
        Ok(())
    }
    fn refresh(&mut self, id: &str, force: bool) -> Result<()> {
        let w = self.workspace(id)?;
        let count = self
            .handle
            .state
            .lock()
            .unwrap()
            .workflows
            .get(id)
            .map_or(0, Vec::len);
        let lifetime = std::time::Duration::from_secs(30.max(count as u64 * 3));
        if !force
            && self
                .refreshed
                .get(id)
                .is_some_and(|t| t.elapsed() < lifetime)
        {
            return Ok(());
        }
        let repo = self.api.repo(&w.repository)?;
        let mut workflows = self.api.workflows(&w.repository)?;
        // Bound concurrency to four requests, including repositories with many workflows.
        for chunk in workflows.chunks_mut(4) {
            std::thread::scope(|scope| -> Result<()> {
                let tasks: Vec<_> = chunk
                    .iter()
                    .map(|workflow| {
                        let api = &self.api;
                        let name = &w.repository;
                        let id = workflow.id;
                        scope.spawn(move || api.latest(name, id))
                    })
                    .collect();
                for (workflow, task) in chunk.iter_mut().zip(tasks) {
                    workflow.last_run = task
                        .join()
                        .map_err(|_| anyhow::anyhow!("Workflow refresh worker stopped."))??;
                }
                Ok(())
            })?;
        }
        let mut state = self.handle.state.lock().unwrap();
        state.defaults.insert(id.into(), repo.default_branch);
        state.workflows.insert(id.into(), workflows);
        self.refreshed.insert(id.into(), Instant::now());
        Ok(())
    }
    fn process(&mut self, command: Command) -> Result<()> {
        match command {
            Command::Add(value) => {
                // Keep the checked workspace set stable throughout a running batch.
                ensure!(
                    !self.handle.queue.lock().unwrap().running,
                    "Wait for the running queue before adding a workspace."
                );
                let repo = self.api.repo(&repository(&value)?)?;
                self.api.workflows(&repo.full_name)?;
                let mut config = self.config();
                let id = if let Some(w) = config
                    .workspaces
                    .iter()
                    .find(|w| w.repository.eq_ignore_ascii_case(&repo.full_name))
                {
                    w.id.clone()
                } else {
                    let id = uuid::Uuid::new_v4().to_string();
                    config.workspaces.push(Workspace {
                        id: id.clone(),
                        repository: repo.full_name,
                        branch: Some(repo.default_branch),
                    });
                    id
                };
                config.active_workspace_id = Some(id.clone());
                self.commit(config)?;
                self.refresh(&id, true)?;
            }
            Command::Select(id) => {
                self.workspace(&id)?;
                let mut config = self.config();
                config.active_workspace_id = Some(id.clone());
                self.commit(config)?;
                self.refresh(&id, false)?;
            }
            Command::Remove(id) => {
                let queue = self.handle.queue.lock().unwrap();
                ensure!(
                    !queue.running,
                    "Wait for the running queue before removing a workspace."
                );
                drop(queue);
                self.workspace(&id)?;
                let mut config = self.config();
                config.workspaces.retain(|w| w.id != id);
                if config.active_workspace_id.as_deref() == Some(&id) {
                    config.active_workspace_id = config.workspaces.first().map(|w| w.id.clone());
                }
                self.commit(config)?;
                self.handle.state.lock().unwrap().workflows.remove(&id);
                self.refreshed.remove(&id);
                if let Some(active) = self.config().active_workspace_id {
                    self.refresh(&active, false)?;
                }
            }
            Command::Branch(id, value) => {
                let w = self.workspace(&id)?;
                let value = branch(&value)?;
                self.api.validate_branch(&w.repository, &value)?;
                let mut config = self.config();
                config
                    .workspaces
                    .iter_mut()
                    .find(|w| w.id == id)
                    .unwrap()
                    .branch = Some(value);
                self.commit(config)?;
                self.handle.state.lock().unwrap().notice =
                    Some("Branch saved for this workspace.".into());
            }
            Command::Refresh(id, force) => self.refresh(&id, force)?,
            Command::Inputs(id, workflow, value) => {
                let w = self.workspace(&id)?;
                let value = branch(&value)?;
                self.api.validate_branch(&w.repository, &value)?;
                let workflows = self.api.workflows(&w.repository)?;
                let workflow = workflows
                    .iter()
                    .find(|w| w.id == workflow)
                    .context("Workflow not found.")?;
                let schema = self.api.schema(&w.repository, workflow, &value)?;
                ensure!(
                    schema.dispatchable,
                    "This workflow does not support workflow_dispatch on this branch."
                );
                self.handle.state.lock().unwrap().schema = Some(SchemaReply {
                    workspace: id,
                    branch: value,
                    workflow: workflow.id,
                    schema,
                });
            }
            Command::Run {
                workspace,
                ids,
                branch: value,
                multiple,
                inputs,
            } => {
                let w = self.workspace(&workspace)?;
                let value = branch(&value)?;
                {
                    let mut q = self.handle.queue.lock().unwrap();
                    ensure!(!q.running, "Another workspace queue is already running.");
                    *q = Queue {
                        running: true,
                        workspace_id: workspace,
                        repository: w.repository.clone(),
                        ..Queue::default()
                    };
                }
                self.handle.stop.store(false, Ordering::SeqCst);
                let launch = || -> Result<_> {
                    let repositories: Vec<_> = self
                        .config()
                        .workspaces
                        .iter()
                        .map(|w| w.repository.clone())
                        .collect();
                    runner::check_other_runs(self.api.as_ref(), &w.repository, &repositories)?;
                    let prepared = runner::prepare(
                        self.api.as_ref(),
                        &w.repository,
                        &ids,
                        multiple,
                        &value,
                        &inputs,
                    )?;
                    // Dispatch must also be enabled on the repository's default branch.
                    let repo = self.api.repo(&w.repository)?;
                    if repo.default_branch != value {
                        for item in &prepared {
                            ensure!(
                                self.api
                                    .schema(&w.repository, &item.workflow, &repo.default_branch)?
                                    .dispatchable,
                                "Workflow {} must support workflow_dispatch on the default branch.",
                                item.workflow.name
                            );
                        }
                    }
                    let actor = self.api.actor()?;
                    ensure!(
                        !self.handle.stop.load(Ordering::SeqCst),
                        "Queue stopped before launch."
                    );
                    Ok((repositories, prepared, actor))
                };
                let (repositories, prepared, actor) = match launch() {
                    Ok(result) => result,
                    Err(error) => {
                        let mut q = self.handle.queue.lock().unwrap();
                        q.running = false;
                        q.error = Some(error.to_string());
                        return Err(error);
                    }
                };
                self.handle.queue.lock().unwrap().items = prepared
                    .iter()
                    .map(|p| QueueItem {
                        workflow_id: p.workflow.id,
                        name: p.workflow.name.clone(),
                        branch: value.clone(),
                        status: "pending".into(),
                        run: None,
                        error: None,
                    })
                    .collect();
                let api = self.api.clone();
                let queue = self.handle.queue.clone();
                let stop = self.handle.stop.clone();
                std::thread::spawn(move || {
                    runner::execute(
                        api.as_ref(),
                        &queue,
                        &stop,
                        prepared,
                        &repositories,
                        actor.as_deref(),
                        &Timing::default(),
                    )
                });
            }
        }
        Ok(())
    }
}
