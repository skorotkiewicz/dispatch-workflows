use crate::model::{branch, repository};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::PathBuf,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Workspace {
    pub id: String,
    pub repository: String,
    #[serde(deserialize_with = "required_optional")]
    pub branch: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    #[serde(deserialize_with = "required_optional")]
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
    pub fn load(&self, bootstrap: Option<&str>) -> Result<Config> {
        let (mut config, fresh) = match fs::read(&self.path) {
            Ok(bytes) => (
                serde_json::from_slice::<Config>(&bytes).context(
                    "Could not read workspace configuration. Existing settings were kept.",
                )?,
                false,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (bootstrap_config(bootstrap)?, true)
            }
            Err(error) => {
                return Err(error).context(
                    "Could not read workspace configuration. Existing settings were kept.",
                );
            }
        };
        config.validate()?;
        if fresh {
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

fn required_optional<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
