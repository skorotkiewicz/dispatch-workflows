use anyhow::{Result, bail, ensure};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub fn repository(value: &str) -> Result<String> {
    let trimmed = value.trim();
    let name = if trimmed.starts_with("https://") {
        let url = url::Url::parse(trimmed)?;
        ensure!(
            url.host_str() == Some("github.com")
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Use a repository URL on https://github.com without credentials, query, or fragment."
        );
        url.path().trim_matches('/').to_owned()
    } else {
        trimmed.to_owned()
    };
    let name = name.strip_suffix(".git").unwrap_or(&name);
    let parts: Vec<_> = name.split('/').collect();
    ensure!(
        parts.len() == 2,
        "Repository must be owner/repo or https://github.com/owner/repo."
    );
    let owner = parts[0];
    let repo = parts[1];
    ensure!(
        !owner.is_empty()
            && owner.len() <= 39
            && owner
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            && owner.as_bytes()[0].is_ascii_alphanumeric()
            && owner.as_bytes()[owner.len() - 1].is_ascii_alphanumeric()
            && !repo.is_empty()
            && repo.len() <= 100
            && repo != "."
            && repo != ".."
            && repo
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)),
        "Invalid repository name."
    );
    Ok(name.to_owned())
}

pub fn branch(value: &str) -> Result<String> {
    ensure!(
        !value.is_empty()
            && value.len() <= 255
            && value.trim() == value
            && !value
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
            && !value.contains("..")
            && !value.contains("@{")
            && !value.contains("//")
            && !value.starts_with('/')
            && !value.ends_with('/')
            && !value.ends_with('.')
            && !value
                .split('/')
                .any(|p| p.starts_with('.') || p.ends_with(".lock")),
        "Choose a valid branch name."
    );
    let value = value.strip_prefix("refs/heads/").unwrap_or(value);
    ensure!(
        !value.is_empty() && value != "@",
        "Choose a valid branch name."
    );
    Ok(value.to_owned())
}

pub fn safe_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Repository {
    pub full_name: String,
    pub default_branch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Workflow {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
    #[serde(skip)]
    pub last_run: Option<Run>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Run {
    pub id: u64,
    pub workflow_id: u64,
    pub event: String,
    #[serde(default)]
    pub head_branch: Option<String>,
    #[serde(default)]
    pub run_attempt: Option<u32>,
    pub status: String,
    pub conclusion: Option<String>,
    pub created_at: DateTime<Utc>,
    pub run_started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub actor: Option<Actor>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Actor {
    pub login: String,
}
impl Run {
    pub fn started(&self) -> DateTime<Utc> {
        self.run_started_at.unwrap_or(self.created_at)
    }
    pub fn duration(&self) -> i64 {
        let end = if self.status == "completed" {
            self.updated_at
        } else {
            Utc::now()
        };
        (end - self.started()).num_seconds().max(0)
    }
    pub fn result(&self) -> &str {
        self.conclusion.as_deref().unwrap_or(&self.status)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recency {
    Hour,
    Day,
    Week,
    Stale,
    Never,
}
pub fn recency(run: Option<&Run>, now: DateTime<Utc>) -> Recency {
    let Some(run) = run else {
        return Recency::Never;
    };
    match (now - run.started()).num_seconds().max(0) {
        age if age < 43_200 => Recency::Hour,
        age if age < 86_400 => Recency::Day,
        age if age <= 604_800 => Recency::Week,
        _ => Recency::Stale,
    }
}
pub fn relative_time(run: Option<&Run>) -> String {
    let Some(run) = run else {
        return "Never run".into();
    };
    let seconds = (Utc::now() - run.started()).num_seconds().max(0);
    if seconds < 60 {
        "Just now".into()
    } else if seconds < 3600 {
        format!("{}m ago", seconds / 60)
    } else if seconds < 86400 {
        format!("{}h ago", seconds / 3600)
    } else {
        format!("{}d ago", seconds / 86400)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    String,
    Boolean,
    Number,
    Choice,
    Environment,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Input {
    pub name: String,
    pub description: String,
    pub kind: InputType,
    pub required: bool,
    pub default: Value,
    pub options: Vec<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Schema {
    pub dispatchable: bool,
    pub inputs: Vec<Input>,
}

pub fn parse_schema(source: &str) -> Result<Schema> {
    ensure!(source.len() <= 1024 * 1024, "Workflow file exceeds 1 MB.");
    let yaml: serde_yaml::Value = serde_yaml::from_str(source)
        .map_err(|_| anyhow::anyhow!("The workflow YAML could not be parsed safely."))?;
    let on = &yaml["on"];
    let dispatchable = on.as_str() == Some("workflow_dispatch")
        || on
            .as_sequence()
            .is_some_and(|s| s.iter().any(|v| v.as_str() == Some("workflow_dispatch")))
        || on
            .as_mapping()
            .is_some_and(|m| m.contains_key(serde_yaml::Value::String("workflow_dispatch".into())));
    let mut schema = Schema {
        dispatchable,
        inputs: vec![],
    };
    if !dispatchable {
        return Ok(schema);
    }
    let defs = &on["workflow_dispatch"]["inputs"];
    if defs.is_null() {
        return Ok(schema);
    }
    let defs = defs
        .as_mapping()
        .ok_or_else(|| anyhow::anyhow!("Invalid workflow_dispatch inputs."))?;
    for (name, def) in defs {
        let name = name
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid input name."))?
            .to_owned();
        ensure!(
            def.is_null() || def.is_mapping(),
            "Invalid input definition for {name}."
        );
        let kind = match def["type"].as_str().unwrap_or("string") {
            "string" => InputType::String,
            "boolean" => InputType::Boolean,
            "number" => InputType::Number,
            "choice" => InputType::Choice,
            "environment" => InputType::Environment,
            _ => bail!("Unsupported input type for {name}."),
        };
        let options = if kind == InputType::Choice {
            let options = def["options"]
                .as_sequence()
                .ok_or_else(|| anyhow::anyhow!("Invalid choices for {name}."))?;
            ensure!(!options.is_empty(), "Invalid choices for {name}.");
            options
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| anyhow::anyhow!("Invalid choice for {name}."))
                })
                .collect::<Result<Vec<_>>>()?
        } else {
            vec![]
        };
        schema.inputs.push(Input {
            name,
            description: def["description"].as_str().unwrap_or_default().into(),
            kind,
            required: def["required"].as_bool().unwrap_or(false),
            default: serde_json::to_value(&def["default"])?,
            options,
        });
    }
    Ok(schema)
}

pub fn validate_inputs(
    schema: &Schema,
    supplied: &Map<String, Value>,
) -> Result<Map<String, Value>> {
    ensure!(
        schema.dispatchable,
        "This workflow does not support workflow_dispatch on this branch."
    );
    for name in supplied.keys() {
        ensure!(
            schema.inputs.iter().any(|i| &i.name == name),
            "Unknown workflow input: {name}."
        );
    }
    let mut result = Map::new();
    for input in &schema.inputs {
        let value = supplied.get(&input.name).unwrap_or(&input.default);
        if value.is_null() || value.as_str() == Some("") {
            ensure!(!input.required, "Input {} is required.", input.name);
            if supplied.contains_key(&input.name)
                && value.as_str() == Some("")
                && matches!(input.kind, InputType::String | InputType::Environment)
            {
                result.insert(input.name.clone(), value.clone());
            }
            continue;
        }
        let value = match input.kind {
            InputType::Boolean => match value {
                Value::Bool(_) => value.clone(),
                Value::String(s) if s == "true" || s == "false" => Value::Bool(s == "true"),
                _ => bail!("Input {} must be true or false.", input.name),
            },
            InputType::Number => {
                let number = value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
                let number = number.filter(|n| n.is_finite()).ok_or_else(|| {
                    anyhow::anyhow!("Input {} must be a finite number.", input.name)
                })?;
                serde_json::json!(number)
            }
            _ => {
                let text = value
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Input {} must be text.", input.name))?;
                ensure!(
                    !input.required || !text.trim().is_empty(),
                    "Input {} is required.",
                    input.name
                );
                ensure!(
                    input.kind != InputType::Choice || input.options.iter().any(|v| v == text),
                    "Input {} must be one of its listed choices.",
                    input.name
                );
                value.clone()
            }
        };
        result.insert(input.name.clone(), value);
    }
    Ok(result)
}
