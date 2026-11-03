use crate::model::{branch, repository};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Workspace {
    pub id: String,
    pub repository: String,
    pub branch: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub active_workspace_id: Option<String>,
    pub workspaces: Vec<Workspace>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 2,
            active_workspace_id: None,
            workspaces: vec![],
        }
    }
}
impl Config {
    pub fn validate(&mut self) -> Result<()> {
        ensure!(
            self.version == 2,
            "Unsupported workspace configuration version."
        );
        let mut ids = HashSet::new();
        let mut repos = HashSet::new();
        for w in &mut self.workspaces {
            ensure!(
                !w.id.is_empty()
                    && w.id.len() <= 255
                    && w.id.trim() == w.id
                    && !w.id.chars().any(char::is_control),
                "Invalid workspace ID."
            );
            w.repository = repository(&w.repository)?;
            if let Some(value) = &w.branch {
                w.branch = Some(branch(value)?);
            }
            ensure!(
                ids.insert(w.id.clone()) && repos.insert(w.repository.to_lowercase()),
                "Duplicate workspace ID or repository."
            );
        }
        ensure!(
            self.active_workspace_id
                .as_ref()
                .is_none_or(|id| ids.contains(id)),
            "The active workspace does not exist."
        );
        Ok(())
    }
    pub fn active(&self) -> Option<&Workspace> {
        self.workspaces
            .iter()
            .find(|w| Some(&w.id) == self.active_workspace_id.as_ref())
    }
}

pub struct Store {
    pub path: PathBuf,
    _lock: File,
}
impl Store {
    pub fn open(path: PathBuf) -> Result<Self> {
        let directory = path
            .parent()
            .context("Configuration needs a parent directory.")?;
        fs::create_dir_all(directory).context("Could not create settings directory.")?;
        let lock = File::options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("dispatch.lock"))?;
        lock.try_lock()
            .context("Another native Dispatch instance is using these settings.")?;
        Ok(Self { path, _lock: lock })
    }
    pub fn default_path() -> Result<PathBuf> {
        if let Some(path) = std::env::var_os("DATA_DIR") {
            return Ok(PathBuf::from(path).join("config.json"));
        }
        Ok(directories::ProjectDirs::from("", "", "dispatch")
            .context("Could not locate the application settings directory.")?
            .config_dir()
            .join("config.json"))
    }
    pub fn load(&self, legacy: Option<&Path>, bootstrap: Option<&str>) -> Result<Config> {
        let source = if self.path.exists() {
            Some(self.path.as_path())
        } else {
            legacy.filter(|p| p.exists())
        };
        let mut migrated = false;
        let mut config = if let Some(source) = source {
            let value: serde_json::Value = serde_json::from_slice(&fs::read(source)?)
                .context("Could not read workspace configuration. Existing settings were kept.")?;
            if value.get("version").is_some() {
                serde_json::from_value(value).context("Invalid workspace configuration.")?
            } else {
                migrated = true;
                ensure!(
                    value.is_null()
                        || value
                            .as_object()
                            .is_some_and(|o| o.contains_key("repository")),
                    "Invalid legacy settings."
                );
                let repo = match value.get("repository") {
                    Some(serde_json::Value::String(repo)) => Some(repo.as_str()),
                    None | Some(serde_json::Value::Null) => bootstrap,
                    _ => anyhow::bail!("Invalid legacy repository."),
                };
                bootstrap_config(repo)?
            }
        } else {
            bootstrap_config(bootstrap)?
        };
        config.validate()?;
        if migrated || source != Some(self.path.as_path()) {
            self.save(&config)?;
        }
        Ok(config)
    }
    pub fn save(&self, config: &Config) -> Result<()> {
        let mut check = config.clone();
        check.validate()?;
        let directory = self.path.parent().context("Missing settings directory.")?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer_pretty(&mut file, &check)?;
        file.write_all(b"\n")?;
        file.as_file().sync_all()?;
        file.persist(&self.path)
            .context("Could not save workspace configuration.")?;
        Ok(())
    }
}
fn bootstrap_config(repo: Option<&str>) -> Result<Config> {
    let mut config = Config::default();
    if let Some(repo) = repo {
        let id = uuid::Uuid::new_v4().to_string();
        config.workspaces.push(Workspace {
            id: id.clone(),
            repository: repository(repo)?,
            branch: None,
        });
        config.active_workspace_id = Some(id);
    }
    Ok(config)
}
