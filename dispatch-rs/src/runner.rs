use crate::{github::GitHub, model::*};
use anyhow::{Result, bail, ensure};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default)]
pub struct Queue {
    pub running: bool,
    pub workspace_id: String,
    pub repository: String,
    pub items: Vec<QueueItem>,
    pub error: Option<String>,
}
#[derive(Clone, Debug)]
pub struct QueueItem {
    pub workflow_id: u64,
    pub name: String,
    pub branch: String,
    pub status: String,
    pub run: Option<Run>,
    pub error: Option<String>,
}
pub struct Prepared {
    pub workflow: Workflow,
    pub inputs: Map<String, Value>,
}
#[derive(Clone)]
pub struct Timing {
    pub poll: Duration,
    pub idle: Duration,
    pub monitor: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(10),
            idle: Duration::from_secs(1800),
            monitor: Duration::from_secs(86400),
        }
    }
}

pub fn prepare(
    api: &dyn GitHub,
    repo: &str,
    ids: &[u64],
    multiple: bool,
    value: &str,
    inputs: &std::collections::HashMap<u64, Map<String, Value>>,
) -> Result<Vec<Prepared>> {
    ensure!(
        !ids.is_empty() && ids.iter().all(|id| *id > 0),
        "Select at least one workflow."
    );
    ensure!(
        ids.iter().copied().collect::<HashSet<_>>().len() == ids.len(),
        "Workflow IDs must be unique."
    );
    ensure!(
        ids.len() == 1 || multiple,
        "Enable Allow multiple workflows before selecting a batch."
    );
    ensure!(
        inputs.keys().all(|id| ids.contains(id)),
        "Inputs contain an unselected workflow."
    );
    let branch = branch(value)?;
    api.validate_branch(repo, &branch)?;
    let workflows = api.workflows(repo)?;
    let mut prepared = Vec::new();
    for id in ids {
        let workflow = workflows
            .iter()
            .find(|w| w.id == *id)
            .ok_or_else(|| anyhow::anyhow!("Workflow {id} was not found."))?;
        ensure!(
            workflow.state == "active",
            "Workflow {} is not active.",
            workflow.name
        );
        // All selected schemas and inputs must validate before the first dispatch.
        let schema = api.schema(repo, workflow, &branch)?;
        let inputs = validate_inputs(&schema, inputs.get(id).unwrap_or(&Map::new()))?;
        prepared.push(Prepared {
            workflow: workflow.clone(),
            inputs,
        });
    }
    Ok(prepared)
}

pub fn check_other_runs(api: &dyn GitHub, repo: &str, repositories: &[String]) -> Result<()> {
    for other in repositories {
        if !other.eq_ignore_ascii_case(repo) {
            ensure!(
                api.active(other)?.is_empty(),
                "Repository {other} has active workflow runs. Wait for them to finish before starting a batch."
            );
        }
    }
    Ok(())
}

pub fn execute(
    api: &dyn GitHub,
    queue: &Arc<Mutex<Queue>>,
    stop: &AtomicBool,
    prepared: Vec<Prepared>,
    repositories: &[String],
    timing: &Timing,
) {
    let (repo, branch) = {
        let q = queue.lock().unwrap();
        (
            q.repository.clone(),
            q.items
                .first()
                .map(|i| i.branch.clone())
                .unwrap_or_default(),
        )
    };
    for (index, item) in prepared.iter().enumerate() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let result = run_one(
            api,
            &repo,
            &branch,
            item,
            stop,
            repositories,
            timing,
            |status, run| {
                let mut q = queue.lock().unwrap();
                q.items[index].status = status.into();
                if let Some(run) = run {
                    q.items[index].run = Some(run);
                }
            },
        );
        if let Err(error) = result {
            let mut q = queue.lock().unwrap();
            let error = error.to_string();
            q.items[index].status = "failed".into();
            q.items[index].error = Some(error.clone());
            q.error = Some(error);
            break;
        }
    }
    let mut q = queue.lock().unwrap();
    for item in &mut q.items {
        if item.status == "pending" || item.status == "waiting for repository" {
            item.status = "skipped".into();
        }
    }
    q.running = false;
}

fn wait_idle(api: &dyn GitHub, repo: &str, stop: &AtomicBool, timing: &Timing) -> Result<bool> {
    let started = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let idle = api.active(repo)?.is_empty();
        if stop.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if idle {
            return Ok(true);
        }
        ensure!(
            started.elapsed() < timing.idle,
            "Timed out waiting for existing repository runs. Nothing new was dispatched."
        );
        pause(timing.poll, Some(stop));
    }
}
fn pause(duration: Duration, stop: Option<&AtomicBool>) {
    let start = Instant::now();
    while start.elapsed() < duration {
        if stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
            return;
        }
        std::thread::sleep(
            duration
                .saturating_sub(start.elapsed())
                .min(Duration::from_millis(100)),
        );
    }
}
#[allow(clippy::too_many_arguments)]
fn run_one(
    api: &dyn GitHub,
    repo: &str,
    branch: &str,
    prepared: &Prepared,
    stop: &AtomicBool,
    repositories: &[String],
    timing: &Timing,
    mut update: impl FnMut(&str, Option<Run>),
) -> Result<()> {
    update("waiting for repository", None);
    if !wait_idle(api, repo, stop, timing)? {
        return Ok(());
    }
    let id = prepared.workflow.id;
    check_other_runs(api, repo, repositories)?;
    if stop.load(Ordering::SeqCst) {
        return Ok(());
    }
    update("dispatching", None);
    // Monitor only the run ID returned by this dispatch. Never retry the POST.
    let run_id = api.dispatch(repo, id, branch, &prepared.inputs)?;
    update("waiting", None);
    let start = Instant::now();
    loop {
        let run = api.run(repo, run_id)?;
        ensure!(
            run.id == run_id
                && run.workflow_id == id
                && run.event == "workflow_dispatch"
                && run.head_branch.as_deref() == Some(branch)
                && run.run_attempt.unwrap_or(1) == 1,
            "GitHub returned mismatched or rerun details. Batch stopped to avoid tracking the wrong run."
        );
        let finished = run.status == "completed";
        let conclusion = run.conclusion.clone();
        update(
            if finished {
                "completed"
            } else if run.status == "in_progress" {
                "in progress"
            } else {
                "waiting"
            },
            Some(run),
        );
        if finished {
            if conclusion.as_deref() != Some("success") {
                bail!(
                    "Workflow {} finished with {}. Batch stopped.",
                    prepared.workflow.name,
                    conclusion.as_deref().unwrap_or("unknown")
                );
            }
            return Ok(());
        }
        ensure!(
            start.elapsed() < timing.monitor,
            "Timed out monitoring the dispatched run. It may still be running on GitHub; batch stopped."
        );
        pause(timing.poll, None);
    }
}
