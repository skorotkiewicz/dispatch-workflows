use anyhow::{Result, bail};
use chrono::{Duration as ChronoDuration, Utc};
use dispatch_rs::{
    config::{Config, Store, Workspace},
    github::GitHub,
    model::*,
    runner::{self, Queue, QueueItem, Timing},
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Default)]
struct FakeState {
    events: Vec<String>,
    schemas: HashMap<u64, Schema>,
    runs: HashMap<u64, Run>,
    dispatches: usize,
    failure: bool,
    uncertain: bool,
    legacy: bool,
    ambiguous: bool,
    mismatch: bool,
    rerun: bool,
    active: bool,
    other_active: bool,
    stop_after_dispatch: Option<Arc<AtomicBool>>,
}
#[derive(Default)]
struct Fake {
    state: Mutex<FakeState>,
}
fn workflows() -> Vec<Workflow> {
    [1, 2]
        .into_iter()
        .map(|id| Workflow {
            id,
            name: format!("Workflow {id}"),
            path: format!(".github/workflows/{id}.yml"),
            state: "active".into(),
            last_run: None,
        })
        .collect()
}
fn schema() -> Schema {
    Schema {
        dispatchable: true,
        inputs: vec![],
    }
}
fn make_run(id: u64, workflow: u64) -> Run {
    Run {
        id,
        workflow_id: workflow,
        event: "workflow_dispatch".into(),
        head_branch: Some("main".into()),
        run_attempt: Some(1),
        status: "completed".into(),
        conclusion: Some("success".into()),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        html_url: format!("https://github.com/acme/repo/actions/runs/{id}"),
        actor: Some(Actor {
            login: "operator".into(),
        }),
        ..Run::default()
    }
}
impl GitHub for Fake {
    fn auth_source(&self) -> &str {
        "fake"
    }
    fn repo(&self, repo: &str) -> Result<Repository> {
        Ok(Repository {
            full_name: repo.into(),
            default_branch: "main".into(),
        })
    }
    fn workflows(&self, _: &str) -> Result<Vec<Workflow>> {
        Ok(workflows())
    }
    fn latest(&self, _: &str, _: u64) -> Result<Option<Run>> {
        Ok(None)
    }
    fn schema(&self, _: &str, w: &Workflow, _: &str) -> Result<Schema> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .schemas
            .get(&w.id)
            .cloned()
            .unwrap_or_else(schema))
    }
    fn validate_branch(&self, _: &str, branch: &str) -> Result<()> {
        if branch == "missing" {
            bail!("Branch not found.")
        }
        Ok(())
    }
    fn actor(&self) -> Result<Option<String>> {
        Ok(Some("operator".into()))
    }
    fn active(&self, repo: &str) -> Result<Vec<Run>> {
        let mut s = self.state.lock().unwrap();
        s.events.push(format!("idle:{repo}"));
        Ok(if s.active || repo == "acme/other" && s.other_active {
            vec![make_run(100, 1)]
        } else {
            vec![]
        })
    }
    fn dispatch_runs(&self, _: &str, id: u64, _: &str) -> Result<Vec<Run>> {
        let s = self.state.lock().unwrap();
        let mut runs: Vec<_> = s
            .runs
            .values()
            .filter(|r| r.workflow_id == id)
            .cloned()
            .collect();
        if s.ambiguous && !runs.is_empty() {
            let mut duplicate = runs[0].clone();
            duplicate.id += 100;
            runs.push(duplicate);
        }
        Ok(runs)
    }
    fn dispatch(
        &self,
        _: &str,
        workflow: u64,
        _: &str,
        _: &Map<String, Value>,
    ) -> Result<Option<u64>> {
        let mut s = self.state.lock().unwrap();
        s.dispatches += 1;
        s.events.push(format!("dispatch:{workflow}"));
        if s.uncertain {
            bail!("Dispatch outcome is uncertain.")
        }
        let id = 9000 + s.dispatches as u64;
        let mut run = make_run(id, workflow);
        if s.failure {
            run.conclusion = Some("failure".into());
        }
        s.runs.insert(id, run);
        if let Some(stop) = &s.stop_after_dispatch {
            stop.store(true, Ordering::SeqCst);
        }
        Ok(if s.legacy { None } else { Some(id) })
    }
    fn run(&self, _: &str, id: u64) -> Result<Run> {
        let mut s = self.state.lock().unwrap();
        let mut run = s.runs[&id].clone();
        s.events.push(format!("complete:{}", run.workflow_id));
        if s.mismatch {
            run.head_branch = Some("wrong".into());
        }
        if s.rerun {
            run.run_attempt = Some(2);
        }
        Ok(run)
    }
}
fn timing() -> Timing {
    Timing {
        poll: Duration::ZERO,
        idle: Duration::ZERO,
        discovery: Duration::ZERO,
        monitor: Duration::ZERO,
    }
}
fn run_batch(api: &Fake, stop: &AtomicBool) -> Queue {
    let prepared =
        runner::prepare(api, "acme/repo", &[1, 2], true, "main", &HashMap::new()).unwrap();
    let queue = Arc::new(Mutex::new(Queue {
        running: true,
        repository: "acme/repo".into(),
        items: prepared
            .iter()
            .map(|p| QueueItem {
                workflow_id: p.workflow.id,
                name: p.workflow.name.clone(),
                branch: "main".into(),
                status: "pending".into(),
                run: None,
                error: None,
            })
            .collect(),
        ..Queue::default()
    }));
    runner::execute(
        api,
        &queue,
        stop,
        prepared,
        &["acme/repo".into(), "acme/other".into()],
        Some("operator"),
        &timing(),
    );
    queue.lock().unwrap().clone()
}

#[test]
fn repository_and_branch_validation() {
    for value in [
        "acme/repo",
        "https://github.com/acme/repo",
        "https://github.com/acme/repo.git/",
    ] {
        assert_eq!(repository(value).unwrap(), "acme/repo");
    }
    for value in [
        "",
        "acme/..",
        "-owner/repo",
        "a/b/c",
        "https://evil.example/a/b",
        "https://user:secret@github.com/a/b",
        "https://github.com/a/b?x=1",
        "https://github.com:444/a/b",
        "a/b#x",
    ] {
        assert!(repository(value).is_err(), "{value}");
    }
    assert_eq!(branch("refs/heads/feature/test").unwrap(), "feature/test");
    for value in [
        "",
        "@",
        "refs/heads/",
        "../main",
        " main",
        "x.lock",
        "a//b",
        "a@{b",
        "a b",
        "a\\b",
    ] {
        assert!(branch(value).is_err(), "{value}");
    }
}
#[test]
fn only_trusted_github_links_can_open() {
    assert!(safe_url("https://github.com/acme/repo/actions/runs/1").is_some());
    for value in [
        "javascript:alert(1)",
        "https://evil.example/",
        "https://github.com@evil.example/",
        "http://github.com/acme/repo",
        "https://user:pass@github.com/",
    ] {
        assert!(safe_url(value).is_none());
    }
}
#[test]
fn yaml_12_dispatch_forms_and_typed_defaults() {
    for source in [
        "on: workflow_dispatch",
        "on: [push, workflow_dispatch]",
        "on:\n  workflow_dispatch:",
    ] {
        assert!(parse_schema(source).unwrap().dispatchable);
    }
    assert!(!parse_schema("on: push").unwrap().dispatchable);
    let s = parse_schema("on:\n  workflow_dispatch:\n    inputs:\n      dry_run:\n        type: boolean\n        default: false\n        required: true\n      count:\n        type: number\n        default: 0\n      target:\n        type: choice\n        options: [staging, production]\n        default: staging\n").unwrap();
    let values = validate_inputs(&s, &Map::new()).unwrap();
    assert_eq!(values["dry_run"], false);
    assert_eq!(values["count"], 0.0);
    assert_eq!(values["target"], "staging");
}
#[test]
fn malformed_and_duplicate_yaml_is_rejected() {
    for source in [
        "on: [oops",
        "on:\n  workflow_dispatch:\n    inputs: []",
        "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: choice",
        "on: push\non: workflow_dispatch",
        "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: unknown",
    ] {
        assert!(parse_schema(source).is_err(), "{source}");
    }
}
#[test]
fn required_unknown_types_choices_and_optional_empty_inputs() {
    let s = parse_schema("on:\n  workflow_dispatch:\n    inputs:\n      version:\n        required: true\n      flag:\n        type: boolean\n      count:\n        type: number\n      target:\n        type: choice\n        options: [staging, production]\n      environment:\n        type: environment\n").unwrap();
    let valid =
        json!({"version":"v1","flag":"false","count":"0","target":"staging","environment":""});
    let result = validate_inputs(&s, valid.as_object().unwrap()).unwrap();
    assert_eq!(result["flag"], false);
    assert_eq!(result["count"], 0.0);
    assert_eq!(result["environment"], "");
    for invalid in [
        json!({}),
        json!({"version":"  "}),
        json!({"version":1}),
        json!({"version":"v1","x":"bad"}),
        json!({"version":"v1","flag":"yes"}),
        json!({"version":"v1","count":"Infinity"}),
        json!({"version":"v1","target":"unknown"}),
    ] {
        assert!(
            validate_inputs(&s, invalid.as_object().unwrap()).is_err(),
            "{invalid}"
        );
    }
}
#[test]
fn every_input_is_validated_before_any_dispatch() {
    let api = Fake::default();
    api.state.lock().unwrap().schemas.insert(
        2,
        parse_schema(
            "on:\n  workflow_dispatch:\n    inputs:\n      version:\n        required: true",
        )
        .unwrap(),
    );
    assert!(runner::prepare(&api, "acme/repo", &[1, 2], true, "main", &HashMap::new()).is_err());
    assert_eq!(api.state.lock().unwrap().dispatches, 0);
}
#[test]
fn invalid_selections_are_rejected() {
    let api = Fake::default();
    for (ids, multiple, branch) in [
        (vec![], false, "main"),
        (vec![1, 1], true, "main"),
        (vec![1, 2], false, "main"),
        (vec![99], false, "main"),
        (vec![1], false, "missing"),
    ] {
        assert!(
            runner::prepare(&api, "acme/repo", &ids, multiple, branch, &HashMap::new()).is_err()
        );
    }
}
#[test]
fn sequential_execution_waits_for_success() {
    let api = Fake::default();
    let queue = run_batch(&api, &AtomicBool::new(false));
    let state = api.state.lock().unwrap();
    let completed = state.events.iter().position(|s| s == "complete:1").unwrap();
    let dispatched = state.events.iter().position(|s| s == "dispatch:2").unwrap();
    assert!(completed < dispatched);
    assert_eq!(state.dispatches, 2);
    assert!(!queue.running);
    assert!(queue.error.is_none());
}
#[test]
fn failure_stops_batch_and_skips_remaining_items() {
    let api = Fake::default();
    api.state.lock().unwrap().failure = true;
    let queue = run_batch(&api, &AtomicBool::new(false));
    assert_eq!(api.state.lock().unwrap().dispatches, 1);
    assert_eq!(queue.items[0].status, "failed");
    assert_eq!(queue.items[1].status, "skipped");
}
#[test]
fn uncertain_dispatch_is_never_retried() {
    let api = Fake::default();
    api.state.lock().unwrap().uncertain = true;
    let queue = run_batch(&api, &AtomicBool::new(false));
    assert_eq!(api.state.lock().unwrap().dispatches, 1);
    assert!(queue.error.unwrap().contains("uncertain"));
}
#[test]
fn legacy_dispatch_tracks_a_single_matching_run() {
    let api = Fake::default();
    api.state.lock().unwrap().legacy = true;
    let queue = run_batch(&api, &AtomicBool::new(false));
    assert!(queue.error.is_none());
    assert_eq!(api.state.lock().unwrap().dispatches, 2);
}
#[test]
fn ambiguous_legacy_tracking_stops_batch() {
    let api = Fake::default();
    {
        let mut s = api.state.lock().unwrap();
        s.legacy = true;
        s.ambiguous = true;
    }
    let queue = run_batch(&api, &AtomicBool::new(false));
    assert!(queue.error.unwrap().contains("ambiguous"));
    assert_eq!(api.state.lock().unwrap().dispatches, 1);
}
#[test]
fn mismatched_or_rerun_details_stop_batch() {
    for rerun in [true, false] {
        let api = Fake::default();
        {
            let mut s = api.state.lock().unwrap();
            s.rerun = rerun;
            s.mismatch = !rerun;
        }
        let queue = run_batch(&api, &AtomicBool::new(false));
        assert!(queue.error.unwrap().contains("mismatched"));
        assert_eq!(api.state.lock().unwrap().dispatches, 1);
    }
}
#[test]
fn stop_monitors_current_run_and_skips_pending() {
    let stop = Arc::new(AtomicBool::new(false));
    let api = Fake::default();
    api.state.lock().unwrap().stop_after_dispatch = Some(stop.clone());
    let queue = run_batch(&api, &stop);
    assert_eq!(queue.items[0].status, "completed");
    assert_eq!(queue.items[1].status, "skipped");
    assert_eq!(api.state.lock().unwrap().dispatches, 1);
}
#[test]
fn stop_before_dispatch_sends_nothing() {
    let api = Fake::default();
    let queue = run_batch(&api, &AtomicBool::new(true));
    assert!(queue.items.iter().all(|i| i.status == "skipped"));
    assert_eq!(api.state.lock().unwrap().dispatches, 0);
}
#[test]
fn existing_repository_runs_time_out_without_dispatch() {
    let api = Fake::default();
    api.state.lock().unwrap().active = true;
    let queue = run_batch(&api, &AtomicBool::new(false));
    assert!(queue.error.unwrap().contains("existing repository runs"));
    assert_eq!(api.state.lock().unwrap().dispatches, 0);
}
#[test]
fn active_runs_in_another_saved_repository_block_dispatch() {
    let api = Fake::default();
    api.state.lock().unwrap().other_active = true;
    let queue = run_batch(&api, &AtomicBool::new(false));
    assert!(queue.error.unwrap().contains("acme/other"));
    assert_eq!(api.state.lock().unwrap().dispatches, 0);
}
#[test]
fn recency_boundaries_match_the_original() {
    let now = Utc::now();
    for (seconds, expected) in [
        (43199, Recency::Hour),
        (43200, Recency::Day),
        (86400, Recency::Week),
        (604800, Recency::Week),
        (604801, Recency::Stale),
    ] {
        let mut run = make_run(1, 1);
        run.created_at = now - ChronoDuration::seconds(seconds);
        assert_eq!(recency(Some(&run), now), expected);
    }
    assert_eq!(recency(None, now), Recency::Never);
}
#[test]
fn workspace_migration_and_atomic_persistence_keep_existing_choices() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    std::fs::write(&path, r#"{"repository":"acme/repo"}"#).unwrap();
    let store = Store::open(path.clone()).unwrap();
    let mut config = store.load(None, None).unwrap();
    assert_eq!(config.workspaces[0].repository, "acme/repo");
    config.workspaces[0].branch = Some("release".into());
    store.save(&config).unwrap();
    let loaded = store.load(None, Some("ignored/repo")).unwrap();
    assert_eq!(loaded.workspaces[0].branch.as_deref(), Some("release"));
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap()["version"],
        2
    );
}
#[test]
fn importing_web_settings_leaves_the_original_intact() {
    let dir = tempfile::tempdir().unwrap();
    let legacy = dir.path().join("legacy.json");
    let native = dir.path().join("native/config.json");
    let original = r#"{"version":2,"activeWorkspaceId":"w1","workspaces":[{"id":"w1","repository":"acme/repo","branch":"stable"}]}"#;
    std::fs::write(&legacy, original).unwrap();
    let store = Store::open(native).unwrap();
    let config = store.load(Some(&legacy), None).unwrap();
    assert_eq!(config.active_workspace_id.as_deref(), Some("w1"));
    assert_eq!(config.workspaces[0].branch.as_deref(), Some("stable"));
    assert_eq!(std::fs::read_to_string(legacy).unwrap(), original);
}
#[test]
fn malformed_configuration_is_not_overwritten() {
    for original in [
        "{broken",
        "{}",
        "[]",
        r#"{"version":3,"workspaces":[],"activeWorkspaceId":null}"#,
        r#"{"version":2,"workspaces":[],"activeWorkspaceId":"missing"}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, original).unwrap();
        let store = Store::open(path.clone()).unwrap();
        assert!(store.load(None, None).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }
}
#[test]
fn duplicate_workspaces_are_rejected_and_empty_settings_override_bootstrap() {
    let mut config = Config {
        workspaces: vec![
            Workspace {
                id: "a".into(),
                repository: "acme/repo".into(),
                branch: None,
            },
            Workspace {
                id: "b".into(),
                repository: "ACME/REPO".into(),
                branch: None,
            },
        ],
        ..Config::default()
    };
    assert!(config.validate().is_err());
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("config.json")).unwrap();
    store.save(&Config::default()).unwrap();
    assert!(
        store
            .load(None, Some("acme/repo"))
            .unwrap()
            .workspaces
            .is_empty()
    );
}
#[test]
fn only_one_native_instance_can_open_the_same_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let first = Store::open(path.clone()).unwrap();
    assert!(Store::open(path.clone()).is_err());
    drop(first);
    assert!(Store::open(path).is_ok());
}
