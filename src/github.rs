use crate::model::*;
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use reqwest::{Method, blocking::Client, redirect::Policy};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::Duration,
};
use wait_timeout::ChildExt;

pub trait GitHub: Send + Sync {
    fn auth_source(&self) -> &str;
    fn repo(&self, repo: &str) -> Result<Repository>;
    fn workflows(&self, repo: &str) -> Result<Vec<Workflow>>;
    fn latest(&self, repo: &str, id: u64) -> Result<Option<Run>>;
    fn schema(&self, repo: &str, workflow: &Workflow, branch: &str) -> Result<Schema>;
    fn validate_branch(&self, repo: &str, branch: &str) -> Result<()>;
    fn active(&self, repo: &str) -> Result<Vec<Run>>;
    fn dispatch(
        &self,
        repo: &str,
        id: u64,
        branch: &str,
        inputs: &Map<String, Value>,
    ) -> Result<u64>;
    fn run(&self, repo: &str, id: u64) -> Result<Run>;
}

pub struct ClientGitHub {
    client: Client,
    token: Option<String>,
    source: String,
}
impl ClientGitHub {
    pub fn new() -> Result<Self> {
        let (token, source) = resolve_auth();
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(10))
            .redirect(Policy::none())
            .user_agent("dispatch-native")
            .build()?;
        Ok(Self {
            client,
            token,
            source,
        })
    }
    fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value> {
        ensure!(
            path.starts_with('/') && !path.starts_with("//"),
            "Invalid GitHub API path."
        );
        let is_dispatch = method == Method::POST;
        let mut request = self
            .client
            .request(method, format!("https://api.github.com{path}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .query(query);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|_| anyhow::anyhow!(if is_dispatch {
            "Could not confirm dispatch. Its outcome is uncertain; it will not be retried. Inspect GitHub before starting another queue."
        } else { "Could not reach GitHub, or the request timed out." }))?;
        let status = response.status();
        let bytes = response.bytes().map_err(|_| {
            anyhow::anyhow!(if is_dispatch {
                "Unreadable dispatch response. Its outcome is uncertain; it will not be retried."
            } else {
                "Unreadable GitHub response."
            })
        })?;
        let data: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!(if is_dispatch { "Unreadable dispatch response. Its outcome is uncertain; it will not be retried." } else { "Unreadable GitHub response." }))?
        };
        if !status.is_success() {
            let hint = match status.as_u16() {
                401 => " Check GH_TOKEN/GITHUB_TOKEN or gh auth login.",
                403 | 429 => " Check Actions permissions, SSO, and API rate limits.",
                _ => "",
            };
            let mut message = data["message"]
                .as_str()
                .unwrap_or("Request failed")
                .to_owned();
            if let Some(token) = &self.token {
                message = message.replace(token, "[redacted]");
            }
            let message: String = message.chars().take(300).collect();
            bail!(
                "GitHub {}: {}.{}{}",
                status.as_u16(),
                message,
                hint,
                if is_dispatch {
                    " Dispatch will not be retried. Inspect GitHub before starting another queue."
                } else {
                    ""
                }
            );
        }
        Ok(data)
    }
    fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        serde_json::from_value(self.request(Method::GET, path, query, None)?)
            .context("GitHub returned unexpected data.")
    }
    fn pages<T: DeserializeOwned>(
        &self,
        path: &str,
        property: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<T>> {
        let mut all = Vec::new();
        for page in 1..=100 {
            let mut query = query.to_vec();
            query.push(("per_page", "100".into()));
            query.push(("page", page.to_string()));
            let data: Value = self.get(path, &query)?;
            let list = data[property]
                .as_array()
                .context("GitHub returned an invalid list.")?;
            for item in list {
                all.push(
                    serde_json::from_value(item.clone())
                        .context("GitHub returned an invalid list item.")?,
                );
            }
            if list.len() < 100
                || data["total_count"]
                    .as_u64()
                    .is_some_and(|n| all.len() as u64 >= n)
            {
                return Ok(all);
            }
        }
        bail!("GitHub pagination exceeded its safety limit. No incomplete list will be used.")
    }
}
fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
fn repo_path(repo: &str) -> Result<String> {
    Ok(format!("/repos/{}", repository(repo)?))
}
impl GitHub for ClientGitHub {
    fn auth_source(&self) -> &str {
        &self.source
    }
    fn repo(&self, repo: &str) -> Result<Repository> {
        let mut repo: Repository = self.get(&repo_path(repo)?, &[])?;
        repo.full_name = repository(&repo.full_name)?;
        repo.default_branch = branch(&repo.default_branch)?;
        Ok(repo)
    }
    fn workflows(&self, repo: &str) -> Result<Vec<Workflow>> {
        self.pages(
            &format!("{}/actions/workflows", repo_path(repo)?),
            "workflows",
            &[],
        )
    }
    fn latest(&self, repo: &str, id: u64) -> Result<Option<Run>> {
        let data: Value = self.get(
            &format!("{}/actions/workflows/{id}/runs", repo_path(repo)?),
            &[("per_page", "1".into())],
        )?;
        let runs = data["workflow_runs"]
            .as_array()
            .context("GitHub returned invalid workflow runs.")?;
        runs.first()
            .map(|r| serde_json::from_value(r.clone()).context("Invalid workflow run."))
            .transpose()
    }
    fn schema(&self, repo: &str, workflow: &Workflow, branch: &str) -> Result<Schema> {
        ensure!(
            workflow.path.starts_with(".github/workflows/")
                && !workflow.path.split('/').any(|s| s == "." || s == ".."),
            "Invalid workflow file path."
        );
        let path = workflow
            .path
            .split('/')
            .map(segment)
            .collect::<Vec<_>>()
            .join("/");
        let data: Value = self.get(
            &format!("{}/contents/{path}", repo_path(repo)?),
            &[("ref", branch.into())],
        )?;
        ensure!(
            data["encoding"] == "base64" && data["size"].as_u64().is_some_and(|n| n <= 1024 * 1024),
            "GitHub did not return a readable workflow file, maximum 1 MB."
        );
        let encoded = data["content"]
            .as_str()
            .context("Missing workflow contents.")?;
        ensure!(encoded.len() <= 1_500_000, "Workflow file exceeds 1 MB.");
        let bytes = base64::engine::general_purpose::STANDARD.decode(
            encoded
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>(),
        )?;
        parse_schema(std::str::from_utf8(&bytes).context("Workflow is not UTF-8.")?)
    }
    fn validate_branch(&self, repo: &str, value: &str) -> Result<()> {
        let value = branch(value)?;
        let data: Value = self.get(
            &format!("{}/branches/{}", repo_path(repo)?, segment(&value)),
            &[],
        )?;
        ensure!(
            data["name"].as_str() == Some(&value),
            "GitHub returned a different branch."
        );
        Ok(())
    }
    fn active(&self, repo: &str) -> Result<Vec<Run>> {
        let mut all: Vec<Run> = vec![];
        for status in ["in_progress", "queued", "waiting", "requested", "pending"] {
            let runs: Vec<Run> = self.pages(
                &format!("{}/actions/runs", repo_path(repo)?),
                "workflow_runs",
                &[("status", status.into())],
            )?;
            for run in runs {
                if run.status != "completed" && !all.iter().any(|r| r.id == run.id) {
                    all.push(run);
                }
            }
        }
        Ok(all)
    }
    fn dispatch(
        &self,
        repo: &str,
        id: u64,
        branch: &str,
        inputs: &Map<String, Value>,
    ) -> Result<u64> {
        ensure!(
            self.token.is_some(),
            "Authenticate with gh auth login or GH_TOKEN/GITHUB_TOKEN before running workflows."
        );
        let data = self.request(
            Method::POST,
            &format!("{}/actions/workflows/{id}/dispatches", repo_path(repo)?),
            &[],
            Some(json!({"ref": branch, "inputs": inputs, "return_run_details": true})),
        )?;
        confirmed_run_id(&data)
    }
    fn run(&self, repo: &str, id: u64) -> Result<Run> {
        self.get(&format!("{}/actions/runs/{id}", repo_path(repo)?), &[])
    }
}
fn resolve_auth() -> (Option<String>, String) {
    for name in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(token) = std::env::var(name)
            && !token.trim().is_empty()
        {
            return (Some(token.trim().into()), "environment".into());
        }
    }
    let cli = || -> Result<String> {
        let mut child = Command::new("gh")
            .args(["auth", "token", "--hostname", "github.com"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        if child.wait_timeout(Duration::from_secs(5))?.is_none() {
            child.kill()?;
            child.wait()?;
            bail!("Authentication timed out.")
        }
        let mut token = String::new();
        child
            .stdout
            .take()
            .context("Missing auth output.")?
            .take(16_384)
            .read_to_string(&mut token)?;
        ensure!(
            child.wait()?.success() && !token.trim().is_empty(),
            "No credentials."
        );
        Ok(token.trim().into())
    };
    match cli() {
        Ok(token) => (Some(token), "gh".into()),
        Err(_) => (None, "none".into()),
    }
}

fn confirmed_run_id(data: &Value) -> Result<u64> {
    data.get("workflow_run_id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .context("GitHub did not return a valid workflow run ID. Dispatch outcome is uncertain; it will not be retried. Inspect GitHub before starting another queue.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_requires_a_confirmed_workflow_run_id() {
        assert_eq!(
            confirmed_run_id(&json!({"workflow_run_id": 9001})).unwrap(),
            9001
        );
        for response in [
            Value::Null,
            json!({}),
            json!({"id": 9001}),
            json!({"workflow_run_id": null}),
            json!({"workflow_run_id": 0}),
            json!({"workflow_run_id": -1}),
            json!({"workflow_run_id": "9001"}),
            json!({"workflow_run_id": 1.5}),
        ] {
            let error = confirmed_run_id(&response).unwrap_err().to_string();
            assert!(error.contains("uncertain"));
            assert!(error.contains("will not be retried"));
        }
    }
}
