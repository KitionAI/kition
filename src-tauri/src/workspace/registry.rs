//! The list of workspace folders the user has opened, kept in
//! `workspaces.json` inside the shared data directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::files::iso_time;

const REGISTRY_FILENAME: &str = "workspaces.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Vault {
    pub path: String,
    pub name: String,
    pub added_at: String,
    pub last_opened_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
struct State {
    vaults: Vec<Vault>,
    active_vault_path: String,
    seeded_default: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Listing {
    pub vaults: Vec<Vault>,
    pub active_vault_path: String,
}

pub struct Registry {
    data_dir: PathBuf,
    file: PathBuf,
    state: State,
    loaded: bool,
    pub was_missing: bool,
}

fn now() -> String {
    iso_time(SystemTime::now())
}

fn basename(input: &str) -> String {
    let trimmed = input.trim().trim_end_matches(['/', '\\']);
    trimmed
        .split(['/', '\\'])
        .rfind(|segment| !segment.is_empty())
        .unwrap_or(trimmed)
        .to_owned()
}

fn sanitize_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.chars().take(200).collect();
    }
    if fallback.is_empty() {
        "Workspace".to_owned()
    } else {
        fallback.to_owned()
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn dedupe(raw: &[Value]) -> Vec<Vault> {
    let mut seen = std::collections::HashSet::new();
    let mut vaults = Vec::new();
    for item in raw {
        let path = text(item, "path").unwrap_or_default().trim().to_owned();
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        vaults.push(Vault {
            name: sanitize_name(&text(item, "name").unwrap_or_default(), &basename(&path)),
            added_at: text(item, "added_at").unwrap_or_else(now),
            last_opened_at: text(item, "last_opened_at").unwrap_or_default(),
            path,
        });
    }
    vaults
}

fn sorted(vaults: &[Vault]) -> Vec<Vault> {
    let mut vaults = vaults.to_vec();
    let key = |vault: &Vault| {
        if vault.last_opened_at.is_empty() {
            vault.added_at.clone()
        } else {
            vault.last_opened_at.clone()
        }
    };
    vaults.sort_by_key(|vault| std::cmp::Reverse(key(vault)));
    vaults
}

impl Registry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            file: data_dir.join(REGISTRY_FILENAME),
            state: State::default(),
            loaded: false,
            was_missing: false,
        }
    }

    pub fn load(&mut self) -> &mut Self {
        if self.loaded {
            return self;
        }
        self.state = match fs::read_to_string(&self.file) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(parsed) => {
                    let vaults = parsed
                        .get("vaults")
                        .and_then(Value::as_array)
                        .map(|items| dedupe(items))
                        .unwrap_or_default();
                    let active = text(&parsed, "active_vault_path")
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    State {
                        active_vault_path: if vaults.iter().any(|vault| vault.path == active) {
                            active
                        } else {
                            String::new()
                        },
                        seeded_default: parsed
                            .get("seeded_default")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        vaults,
                    }
                }
                Err(error) => {
                    eprintln!("failed to load workspace registry, resetting: {error}");
                    State::default()
                }
            },
            Err(error) => {
                if error.kind() == io::ErrorKind::NotFound {
                    self.was_missing = true;
                } else {
                    eprintln!("failed to load workspace registry, resetting: {error}");
                }
                State::default()
            }
        };
        self.loaded = true;
        self
    }

    pub fn reload(&mut self) -> &mut Self {
        self.loaded = false;
        self.was_missing = false;
        self.load()
    }

    fn save(&self) -> io::Result<()> {
        fs::create_dir_all(&self.data_dir)?;
        let payload = serde_json::to_string_pretty(&self.state).map_err(io::Error::other)?;
        let temporary = self.file.with_extension(format!(
            "json.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::write(&temporary, payload)?;
        if let Err(error) = fs::rename(&temporary, &self.file) {
            let _ = fs::remove_file(&self.file);
            if let Err(retry) = fs::rename(&temporary, &self.file) {
                let _ = fs::remove_file(&temporary);
                return Err(if retry.kind() == error.kind() {
                    error
                } else {
                    retry
                });
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Listing {
        Listing {
            vaults: sorted(&self.state.vaults),
            active_vault_path: self.state.active_vault_path.clone(),
        }
    }

    /// Adds `path`, or creates `parent_path/name` and adds that.
    pub fn add(&mut self, path: &str, parent_path: &str, name: &str) -> io::Result<Vault> {
        self.reload();
        let mut resolved = path.trim().to_owned();
        if resolved.is_empty() {
            let parent = parent_path.trim();
            let folder = sanitize_name(name, "");
            if parent.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "vault path or (parent_path + name) is required",
                ));
            }
            let target = Path::new(parent).join(folder);
            fs::create_dir_all(&target)?;
            resolved = target.to_string_lossy().into_owned();
        } else if !fs::metadata(&resolved)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "vault path must be a directory",
            ));
        }
        let resolved_name = sanitize_name(name, &basename(&resolved));
        if let Some(existing) = self
            .state
            .vaults
            .iter_mut()
            .find(|vault| vault.path == resolved)
        {
            if !name.is_empty() {
                existing.name = resolved_name;
            }
        } else {
            self.state.vaults.push(Vault {
                path: resolved.clone(),
                name: resolved_name,
                added_at: now(),
                last_opened_at: String::new(),
            });
        }
        self.save()?;
        self.find(&resolved)
    }

    fn find(&self, path: &str) -> io::Result<Vault> {
        self.state
            .vaults
            .iter()
            .find(|vault| vault.path == path)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "vault not found in registry"))
    }

    pub fn remove(&mut self, path: &str) -> io::Result<Listing> {
        self.reload();
        let target = path.trim();
        if target.is_empty() {
            return Ok(self.list());
        }
        self.state.vaults.retain(|vault| vault.path != target);
        if self.state.active_vault_path == target {
            self.state.active_vault_path.clear();
        }
        self.save()?;
        Ok(self.list())
    }

    pub fn rename(&mut self, path: &str, name: &str) -> io::Result<Vault> {
        self.reload();
        let target = path.trim().to_owned();
        let vault = self
            .state
            .vaults
            .iter_mut()
            .find(|vault| vault.path == target)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "vault not found in registry")
            })?;
        vault.name = sanitize_name(name, &vault.name.clone());
        self.save()?;
        self.find(&target)
    }

    pub fn set_active(&mut self, path: &str) -> io::Result<Listing> {
        self.reload();
        let target = path.trim().to_owned();
        if target.is_empty() {
            self.state.active_vault_path.clear();
            self.save()?;
            return Ok(self.list());
        }
        if !self.state.vaults.iter().any(|vault| vault.path == target) {
            self.add(&target, "", "")?;
        }
        if fs::metadata(&target).is_err() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "workspace directory does not exist",
            ));
        }
        if let Some(vault) = self
            .state
            .vaults
            .iter_mut()
            .find(|vault| vault.path == target)
        {
            vault.last_opened_at = now();
        }
        self.state.active_vault_path = target;
        self.save()?;
        Ok(self.list())
    }

    pub fn clear_active(&mut self) -> io::Result<Listing> {
        self.reload();
        self.state.active_vault_path.clear();
        self.save()?;
        Ok(self.list())
    }

    /// Adds the default workspace once, the first time it exists.
    pub fn seed_default(&mut self, default_path: &Path) -> io::Result<()> {
        self.reload();
        if self.state.seeded_default {
            return Ok(());
        }
        let target = default_path.to_string_lossy().trim().to_owned();
        if target.is_empty() || !fs::metadata(&target).map(|m| m.is_dir()).unwrap_or(false) {
            return Ok(());
        }
        if !self.state.vaults.iter().any(|vault| vault.path == target) {
            self.state.vaults.push(Vault {
                name: sanitize_name("", &basename(&target)),
                path: target,
                added_at: now(),
                last_opened_at: String::new(),
            });
        }
        self.state.seeded_default = true;
        self.save()
    }

    pub fn active_vault_path(&self) -> &str {
        &self.state.active_vault_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_vaults_and_the_active_one() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let data = dir.path().join("data");
        let first = dir.path().join("first");
        fs::create_dir_all(&first).unwrap_or_else(|err| panic!("{err}"));
        let first_path = first.to_string_lossy().into_owned();

        let mut registry = Registry::new(&data);
        registry.load();
        assert!(registry.was_missing);
        let vault = registry
            .add(&first_path, "", "")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(vault.name, "first");

        let created = registry
            .add("", &dir.path().to_string_lossy(), "Second")
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(Path::new(&created.path).is_dir());

        registry
            .set_active(&first_path)
            .unwrap_or_else(|err| panic!("{err}"));
        let listing = registry.list();
        assert_eq!(listing.active_vault_path, first_path);
        assert_eq!(listing.vaults[0].path, first_path);

        let renamed = registry
            .rename(&first_path, "  Main  ")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(renamed.name, "Main");

        let mut reloaded = Registry::new(&data);
        reloaded.load();
        assert!(!reloaded.was_missing);
        assert_eq!(reloaded.active_vault_path(), first_path);

        let listing = reloaded
            .remove(&first_path)
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(listing.active_vault_path, "");
        assert_eq!(listing.vaults.len(), 1);
    }

    #[test]
    fn seeds_the_default_vault_once() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let default = dir.path().join("workspace");
        let mut registry = Registry::new(dir.path());
        registry
            .seed_default(&default)
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(registry.list().vaults.is_empty());
        fs::create_dir_all(&default).unwrap_or_else(|err| panic!("{err}"));
        registry
            .seed_default(&default)
            .unwrap_or_else(|err| panic!("{err}"));
        registry
            .remove(&default.to_string_lossy())
            .unwrap_or_else(|err| panic!("{err}"));
        registry
            .seed_default(&default)
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(registry.list().vaults.is_empty());
    }
}
