// Copied from kition-sdk crates/kition-kit-host/src/kit_home.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The private folder and the environment a kit process starts with (Kit Process Protocol section 3):
//! never the host's current folder, home, temporary folder, or variables.
//!
//! Each launch gets a fresh folder `<base>/kition-kit-home-<random>/` (mode `0700`) holding
//! `work/` (the current folder), `home/` (`HOME`, `USERPROFILE`, the `XDG_*` configuration and
//! data folders and the app-data folders under it) and `tmp/`, all empty. `tmp/` is the kit's
//! private runtime folder (KHP A58): `TMPDIR`, `XDG_RUNTIME_DIR` and `XDG_CACHE_HOME`, and `TEMP`
//! and `TMP`, all name it, so a kit that keeps a socket, a cache or a scratch file finds the one
//! folder whichever variable it reads first. The whole folder is removed when the process ends; one
//! a host left behind (it crashed) is removed by the next launch under the same base, told apart by
//! its lock file, which a running host holds locked. The default base, `kition-kits` in the
//! system's temporary folder, goes with the last private folder in it.
//!
//! This keeps an engine's accidental writes (an auto-save beside a bare name, a cache in `HOME`,
//! a print file in the temporary folder) out of the person's folders and where a test can see
//! them. It does not confine the kit: an absolute path still reaches the file system, unless the
//! kit runs under [`crate::sandbox`]. Kits read and write files only through the host (KHP A29,
//! §10.6).

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

const PREFIX: &str = "kition-kit-home-";
/// The prefix of a lock file being made: locked, then renamed to its own name ([`KitHome::create`]).
const PENDING: &str = ".pending-";
/// How old a pending lock file must be before a sweep takes it for a crashed launch's: one exists
/// only for the moment between its creation and its rename.
const PENDING_STALE: std::time::Duration = std::time::Duration::from_secs(60);

/// Variables a kit gets from the host's environment, when set. Everything else is left out.
pub const PASSED: &[&str] = &[
    // A folder of fonts the operator ships for kits.
    "KITION_FONTS_DIR",
    // A fixed time for outputs that carry one (reproducible files, KHP A26). It never changes ids.
    "SOURCE_DATE_EPOCH",
    // Diagnostics on standard error.
    "RUST_BACKTRACE",
    "RUST_LIB_BACKTRACE",
    "RUST_LOG",
    // Windows needs these to load its own libraries (sockets, crypto).
    #[cfg(windows)]
    "SystemRoot",
    #[cfg(windows)]
    "windir",
];

/// Variables named with this prefix pass too: the kit launch namespace (`KITION_KIT_PROTOCOL`, …,
/// which the host sets itself) and a kit's own settings (`KITION_KIT_<NAME>_…`).
pub const PASSED_PREFIX: &str = "KITION_KIT_";

/// Variables every kit gets fixed, whatever the host's are, so output does not depend on the
/// machine (KHP A26): the C locale in UTF-8 and UTC.
pub const FIXED: &[(&str, &str)] = &[("LANG", "C.UTF-8"), ("LC_ALL", "C.UTF-8"), ("TZ", "UTC")];

/// Whether the host's variable `name` reaches the kit.
#[must_use]
pub fn passes(name: &str) -> bool {
    PASSED.contains(&name) || name.starts_with(PASSED_PREFIX)
}

/// The environment a kit process starts with, but for the four launch variables (Kit Process
/// Protocol section 3): the variables of `host` (the host's own environment) that [`passes`], then
/// [`FIXED`], then [`KitHome::folders`] of `home`. Nothing else of `host` reaches the kit, its
/// `TMPDIR` and folders included.
#[must_use]
pub fn environment(host: impl IntoIterator<Item = (OsString, OsString)>, home: &KitHome) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> = host.into_iter().filter(|(name, _)| name.to_str().is_some_and(passes)).collect();
    environment.extend(FIXED.iter().map(|&(name, value)| (OsString::from(name), OsString::from(value))));
    environment.extend(home.folders());
    environment
}

/// The variables that designate a kit's private runtime folder (KHP A58), in the order a kit reads
/// them: `TMPDIR`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME` on POSIX systems, `TEMP`, `TMP` on Windows.
/// The host sets all five on every system, each to [`KitHome::tmp`].
pub const RUNTIME_VARIABLES: &[&str] = &["TMPDIR", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "TEMP", "TMP"];

/// One kit process's private folder; removed when dropped.
#[derive(Debug)]
pub struct KitHome {
    root: PathBuf,
    lock_path: PathBuf,
    /// Held locked while the folder is in use: a host that died leaves it unlocked.
    _lock: File,
    /// The base is the host's own ([`KitHome::default_base`]): removed with the last folder in it.
    own_base: bool,
}

impl KitHome {
    /// The default base: `kition-kits` in the system's temporary folder.
    #[must_use]
    pub fn default_base() -> PathBuf {
        std::env::temp_dir().join("kition-kits")
    }

    /// [`KitHome::create`] under [`KitHome::default_base`], which goes when the last private
    /// folder in it does, so a host leaves nothing in the system's temporary folder (which is a
    /// harness's private runtime folder when the host is a kit server itself, KHP A58).
    pub fn create_default() -> io::Result<Self> {
        Self::create_in(&Self::default_base(), true)
    }

    /// Makes a fresh private folder under `base` (made, mode `0700`, when missing), after removing
    /// the ones no running host holds. `base` stays when the folder goes.
    pub fn create(base: &Path) -> io::Result<Self> {
        Self::create_in(base, false)
    }

    /// [`KitHome::create`]; with `own_base`, `base` is removed when it is empty after the folder
    /// goes. Another host may remove an empty `base` between this one making it and taking its
    /// lock in it: then it is made again.
    fn create_in(base: &Path, own_base: bool) -> io::Result<Self> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match Self::create_once(base, own_base) {
                Err(error) if own_base && error.kind() == io::ErrorKind::NotFound && attempt < 8 => {}
                made => return made,
            }
        }
    }

    fn create_once(base: &Path, own_base: bool) -> io::Result<Self> {
        make_private(base, true).or_else(|error| if base.is_dir() { Ok(()) } else { Err(error) })?;
        // The real path, so what the kit is told is what it sees (`/var` is `/private/var` on macOS).
        let base = &std::fs::canonicalize(base)?;
        sweep(base);
        let name = format!("{PREFIX}{}", hex::encode(rand::random::<[u8; 8]>()));
        let lock_path = base.join(format!("{name}.lock"));
        // The lock file is made and locked under a name the sweep passes over, and only then given
        // its own: a launch sweeping at the same moment never finds it unlocked, so it never takes
        // it for a crashed host's (nor the folder made next for an orphan).
        let pending = base.join(format!("{PENDING}{name}.lock"));
        let lock = File::options().write(true).create_new(true).open(&pending)?;
        let locked = lock.try_lock().map_err(|error| io::Error::other(error.to_string())).and_then(|()| std::fs::rename(&pending, &lock_path));
        if let Err(error) = locked {
            let _ = std::fs::remove_file(&pending);
            return Err(error);
        }
        let root = base.join(name);
        let made = (|| {
            make_private(&root, false)?;
            for dir in ["work", "home", "tmp"] {
                make_private(&root.join(dir), false)?;
            }
            Ok::<_, io::Error>(())
        })();
        let home = Self { root, lock_path, _lock: lock, own_base };
        made.map(|()| home)
    }

    /// The folder itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The kit's current folder.
    pub fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    pub fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    /// The kit's private runtime folder (KHP A58): every one of [`RUNTIME_VARIABLES`] names it.
    pub fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// The variables that point the kit's home, private runtime, configuration and data folders
    /// here.
    #[must_use]
    pub fn folders(&self) -> Vec<(OsString, OsString)> {
        let (home, tmp) = (self.home(), self.tmp());
        let mut folders: Vec<(&str, PathBuf)> = vec![
            ("HOME", home.clone()),
            ("USERPROFILE", home.clone()),
            ("XDG_CONFIG_HOME", home.join(".config")),
            ("XDG_DATA_HOME", home.join(".local/share")),
            ("XDG_STATE_HOME", home.join(".local/state")),
        ];
        folders.extend(RUNTIME_VARIABLES.iter().map(|name| (*name, tmp.clone())));
        if cfg!(windows) {
            folders.push(("APPDATA", home.join("AppData/Roaming")));
            folders.push(("LOCALAPPDATA", home.join("AppData/Local")));
        }
        folders.into_iter().map(|(name, path)| (OsString::from(name), path.into_os_string())).collect()
    }
}

impl Drop for KitHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_file(&self.lock_path);
        // The host's own base goes with its last folder: `remove_dir` removes only an empty folder,
        // so another host's private folder keeps it.
        if let Some(base) = self.root.parent().filter(|_| self.own_base) {
            let _ = std::fs::remove_dir(base);
        }
    }
}

/// Makes `dir` with mode `0700` on Unix; `recursive` makes its parents too.
fn make_private(dir: &Path, recursive: bool) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Removes the private folders under `base` that no running host holds: a lock file that can be
/// locked, and a folder without a lock file (its lock is made first, already locked, and removed
/// last). A pending lock file ([`PENDING`]) is a launch's that crashed before renaming it once it
/// is old and unlocked.
fn sweep(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(PENDING) {
            let old = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > PENDING_STALE);
            if old && File::options().write(true).open(entry.path()).is_ok_and(|lock| lock.try_lock().is_ok()) {
                let _ = std::fs::remove_file(entry.path());
            }
            continue;
        }
        let Some(rest) = name.strip_prefix(PREFIX) else { continue };
        let (folder, lock_path) = match rest.strip_suffix(".lock") {
            Some(id) => (base.join(format!("{PREFIX}{id}")), entry.path()),
            None => (entry.path(), base.join(format!("{name}.lock"))),
        };
        let unheld = match File::options().write(true).open(&lock_path) {
            Ok(lock) => lock.try_lock().is_ok(),
            Err(error) => error.kind() == io::ErrorKind::NotFound,
        };
        if unheld {
            let _ = std::fs::remove_dir_all(&folder);
            let _ = std::fs::remove_file(&lock_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("kit-home-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        base
    }

    #[test]
    fn a_home_is_private_empty_and_gone_when_dropped() {
        let base = base("drop");
        let home = KitHome::create(&base).unwrap();
        let root = home.root().to_path_buf();
        for dir in [home.work(), home.home(), home.tmp()] {
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "{}", dir.display());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let folders = home.folders();
        assert!(folders.iter().any(|(name, value)| name == "HOME" && Path::new(value) == home.home()));
        drop(home);
        assert!(!root.exists());
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0, "no lock file is left");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_home_no_host_holds_is_swept_and_a_held_one_kept() {
        let base = base("sweep");
        let held = KitHome::create(&base).unwrap();
        // A host that crashed: its folder and an unlocked lock file, and a folder without one.
        let stale = base.join(format!("{PREFIX}0000000000000000"));
        std::fs::create_dir_all(stale.join("work")).unwrap();
        std::fs::write(stale.join("work/auto-save.txt"), b"left").unwrap();
        std::fs::write(base.join(format!("{PREFIX}0000000000000000.lock")), b"").unwrap();
        let orphan = base.join(format!("{PREFIX}1111111111111111"));
        std::fs::create_dir_all(&orphan).unwrap();
        let other = base.join("not-a-kit-home");
        std::fs::create_dir_all(&other).unwrap();
        let fresh = KitHome::create(&base).unwrap();
        assert!(!stale.exists() && !base.join(format!("{PREFIX}0000000000000000.lock")).exists());
        assert!(!orphan.exists());
        assert!(held.root().exists(), "a running host's folder is kept");
        assert!(other.exists(), "only kit homes are swept");
        drop((held, fresh));
        let _ = std::fs::remove_dir_all(base);
    }

    /// regressions/issue-kit-home-race: kits started at once each get their private folder. Before,
    /// a launch's sweep could take another launch's lock file between its creation and its
    /// locking, remove it, and then sweep that launch's new folder as an orphan, so a kit failed
    /// to start ("could not create the kit's private folder: Invalid argument").
    #[test]
    fn homes_made_at_once_under_one_base_all_start_and_stay_until_dropped() {
        let base = base("race");
        let failures: Vec<String> = std::thread::scope(|scope| {
            let launches: Vec<_> = (0..16)
                .map(|_| {
                    scope.spawn(|| {
                        let mut failures = Vec::new();
                        for _ in 0..40 {
                            match KitHome::create(&base) {
                                Ok(home) => {
                                    for dir in [home.work(), home.home(), home.tmp()] {
                                        if !dir.is_dir() {
                                            failures.push(format!("{} was swept while its host held it", dir.display()));
                                        }
                                    }
                                    drop(home);
                                }
                                Err(error) => failures.push(error.to_string()),
                            }
                        }
                        failures
                    })
                })
                .collect();
            launches.into_iter().flat_map(|launch| launch.join().unwrap_or_else(|_| vec!["a launch panicked".to_owned()])).collect()
        });
        assert!(failures.is_empty(), "{} of 640 launches failed, first: {}", failures.len(), failures[0]);
        let left: Vec<_> = std::fs::read_dir(&base).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert!(left.is_empty(), "every home is gone with its host: {left:?}");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn only_listed_variables_pass() {
        for name in ["KITION_FONTS_DIR", "KITION_KIT_TOKEN", "KITION_KIT_MOCK_AS", "RUST_LOG", "SOURCE_DATE_EPOCH"] {
            assert!(passes(name), "{name}");
        }
        // KITION_REPRODUCIBLE_IDS counts a kit's ids (tests and sample builds only): no host passes it.
        for name in
            ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "KITION_SYNC_SECRET", "KITION_WORKSPACE", "AWS_SECRET_ACCESS_KEY", "LANG", "KITION_REPRODUCIBLE_IDS"]
        {
            assert!(!passes(name), "{name}");
        }
    }

    /// The value of `name` in `environment`, which must hold it exactly once.
    fn value_of(environment: &[(OsString, OsString)], name: &str) -> PathBuf {
        let values: Vec<&OsString> = environment.iter().filter(|(key, _)| key == name).map(|(_, value)| value).collect();
        assert_eq!(values.len(), 1, "{name} once in {environment:?}");
        PathBuf::from(values[0])
    }

    /// KHP A58: `TMPDIR`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`, `TEMP` and `TMP` all name one folder,
    /// the kit's private runtime folder, inside its private folder; nothing of the host's own
    /// temporary, cache or home folders reaches the kit, and the variables a kit legitimately
    /// takes do. Before, `XDG_CACHE_HOME` named `home/.cache`, a second folder.
    #[test]
    fn the_runtime_variables_name_the_one_private_runtime_folder() {
        let base = base("a58-env");
        let home = KitHome::create(&base).unwrap();
        let host: Vec<(OsString, OsString)> = [
            ("TMPDIR", "/host/tmp"),
            ("XDG_RUNTIME_DIR", "/run/user/501"),
            ("XDG_CACHE_HOME", "/host/home/.cache"),
            ("TEMP", "/host/temp"),
            ("HOME", "/host/home"),
            ("PATH", "/usr/bin:/bin"),
            ("LANG", "de_DE.UTF-8"),
            ("KITION_FONTS_DIR", "/fonts"),
            ("KITION_KIT_MOCK_AS", "kit.mock"),
        ]
        .iter()
        .map(|&(name, value)| (OsString::from(name), OsString::from(value)))
        .collect();
        let environment = environment(host, &home);
        for name in RUNTIME_VARIABLES {
            assert_eq!(value_of(&environment, name), home.tmp(), "{name}");
        }
        assert_eq!(value_of(&environment, "HOME"), home.home());
        assert_eq!(value_of(&environment, "XDG_CONFIG_HOME"), home.home().join(".config"));
        assert_eq!(value_of(&environment, "LANG"), PathBuf::from("C.UTF-8"), "the host's locale does not pass");
        assert_eq!(value_of(&environment, "KITION_FONTS_DIR"), PathBuf::from("/fonts"));
        assert_eq!(value_of(&environment, "KITION_KIT_MOCK_AS"), PathBuf::from("kit.mock"));
        assert!(!environment.iter().any(|(name, _)| name == "PATH"), "{environment:?}");
        for (name, value) in &environment {
            let value = Path::new(value);
            assert!(!value.starts_with("/host") && !value.starts_with("/run/user"), "{name:?} names a host folder: {}", value.display());
        }
        assert!(home.tmp().starts_with(home.root()) && home.tmp().is_dir());
        drop(home);
        let _ = std::fs::remove_dir_all(base);
    }

    /// KHP A58: each kit server gets a private runtime folder of its own, never another's, and it
    /// goes with the server.
    #[test]
    fn each_launch_has_its_own_runtime_folder_until_it_ends() {
        let base = base("a58-own");
        let (first, second) = (KitHome::create(&base).unwrap(), KitHome::create(&base).unwrap());
        assert_ne!(first.tmp(), second.tmp());
        assert!(!first.tmp().starts_with(second.root()) && !second.tmp().starts_with(first.root()));
        std::fs::write(first.tmp().join("kit.sock"), b"").unwrap();
        let tmp = first.tmp();
        drop(first);
        assert!(!tmp.exists(), "the runtime folder goes with its server");
        assert!(second.tmp().is_dir(), "another server's stays");
        drop(second);
        let _ = std::fs::remove_dir_all(base);
    }

    /// The host's own base (`kition-kits` in the system's temporary folder by default) goes with
    /// the last private folder in it, so a host leaves nothing in its own `TMPDIR`; one that holds
    /// another's stays, and a launch after it makes it again. A base the caller gave stays.
    #[test]
    fn the_hosts_own_base_goes_with_its_last_home() {
        let own = base("own-base").join("kition-kits");
        let first = KitHome::create_in(&own, true).unwrap();
        let second = KitHome::create_in(&own, true).unwrap();
        drop(first);
        assert!(own.is_dir(), "the base holds another host's folder");
        drop(second);
        assert!(!own.exists(), "the base goes with the last folder in it");
        let again = KitHome::create_in(&own, true).unwrap();
        assert!(again.tmp().is_dir());
        drop(again);
        assert!(!own.exists());
        let given = base("given-base");
        drop(KitHome::create(&given).unwrap());
        assert!(given.is_dir(), "a base the caller gave stays");
        let _ = std::fs::remove_dir_all(given);
        let _ = std::fs::remove_dir_all(own.parent().unwrap());
    }
}
