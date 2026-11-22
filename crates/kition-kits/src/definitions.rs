// Copied from kition-sdk crates/kition-kits/src/definitions.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The kits a manager knows, from their Kit Harness Protocol (KHP) manifests (`kit.json`): there
//! is no table of kits here. A kit is found three ways, by its id:
//!
//! - a manifest the embedding host hands over (Kition's desktop shell reads its kit packages'
//!   `kit.json`);
//! - a kits folder holding one folder per kit with its `kit.json` (Kition's `public/kits`, a
//!   `--kits-dir`);
//! - a headless executable: its `kit.json` is the nearest one above it whose
//!   `headless.executable` names it (a kit repository's `target/debug/kition-<name>`), so the
//!   definition is the one the executable was built from.
//!
//! What the agent's tools say about a kit comes from the manifest's `agent.describe`,
//! `agent.render`, and `agent.export` (Kition platform rule K21); a manifest without them still
//! works, worded from the kit's name and formats.
//!
//! A definition lives as long as the process: discovery runs once per manager, and the tools
//! keep `&'static` references to definitions everywhere.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock};

use serde_json::Value;

/// A kit, as its manifest declares it.
#[derive(Debug)]
pub struct KitDefinition {
    /// `kit.json` `id`, for example `kit.photo`.
    pub id: &'static str,
    /// `kit.json` `name`, for example `Photo`.
    pub name: &'static str,
    /// Lowercase extensions, without the dot, that open in this kit: its `edit` formats.
    pub extensions: &'static [&'static str],
    /// Lowercase extensions it only views (its `view` formats it does not also edit): an editor
    /// opens them read-only; the agent's tools do not take them.
    pub views: &'static [&'static str],
    /// The extensions it creates new documents in (`kit.json` `creates[].extension`), with the
    /// type id of each (`creates[].id`).
    pub creates: &'static [(&'static str, &'static str)],
    /// A new document's name before its extension and number (`creates[].baseName`), for example
    /// `Untitled photo`.
    pub base_name: &'static str,
    /// Extensions the kit writes as new files: its `exports` and the files it creates beside its
    /// documents (`files.create`, images pasted into a note). They are only ever new files:
    /// `write_file` never replaces an existing one with them.
    pub exports: &'static [&'static str],
    /// The executable `kit.json` names (`headless.executable`), for example `kition-note`.
    pub executable: Option<&'static str>,
    /// The Kit Process Protocol the executable speaks (`headless.protocol`), for example
    /// `kition-kit/1`; a host launches only a kit that speaks its own.
    pub protocol: Option<&'static str>,
    /// `kit.json` `version`, which a server of this one kit reports as its own (KHP A34).
    pub version: &'static str,
    /// The manifest as it was found, served as `khp://kits/<id>/kit.json` (KHP K20).
    pub manifest: &'static str,
    /// The engine command that answers the document's outline (`kit.json` `outline.command`,
    /// platform K24; `outline.rs`): the parts of a file a host lists under it. `None` when the kit
    /// has none.
    pub outline: Option<&'static str>,
    /// How the agent's tools for this kit read (`kit.json` `agent`).
    pub agent: KitAgent,
}

/// The words the agent's tools for a kit use. The tools are `<prefix>_inspect`,
/// `<prefix>_commands`, and `<prefix>_run` (KHP A3).
#[derive(Debug)]
pub struct KitAgent {
    /// `kit.json` `agent.prefix`.
    pub prefix: &'static str,
    /// `agent.drafts`: the kit keeps an agent's drafts, so it offers the draft tools (KHP A35).
    pub drafts: bool,
    /// `agent.objectModel`: the kit has an object model, so it offers `<prefix>_query` and
    /// `<prefix>_batch` (KHP A16, A35).
    pub object_model: bool,
    /// What one file is, for example `layered image` (`agent.describe.noun`).
    pub noun: &'static str,
    /// The file types as people know them, for example `PSD, PSB, or .kphoto`
    /// (`agent.describe.fileTypes`).
    pub formats: &'static str,
    /// What `<prefix>_inspect` reports (`agent.describe.reports`).
    pub reports: &'static str,
    /// What the commands cover (`agent.describe.covers`).
    pub covers: &'static str,
    /// Keywords that find commands, for example `` `brightness` or `new layer` ``
    /// (`agent.describe.queries`).
    pub queries: &'static str,
    /// One command id, as an example (`agent.describe.example`).
    pub command: &'static str,
    /// What an agent makes one of the kit's files for, for example `structured, spreadsheet-like
    /// results` (`agent.describe.use`); a host's instructions say so ([`KitDefinition::guidance`]).
    /// `None` when the kit names nothing.
    pub use_for: Option<&'static str>,
    /// The engine command that renders a preview of one part of a document or of a diagnostic's
    /// target (KHP A39, `agent.render`): `{slide?, target?, scale?, maxSize?}` answers `{png}`,
    /// base64. `None` when the kit has none, and its previews are `view.screenshot`'s.
    pub render: Option<&'static str>,
    /// The kit's part nouns (`agent.parts`, for example `["sequence"]` or `["comp"]`): the members
    /// a run's `target` and a step's `at.part` take, each naming a part by the kit's own id, passed
    /// unchanged to the kit's `context.set`. `None` when the kit declares none: a part is then
    /// `slide`, `page`, `slideId` or `pageId`.
    pub parts: Option<&'static [&'static str]>,
    /// How `<prefix>_export` writes the document to a new file (KHP A41, `agent.export`); `None`
    /// when the agent cannot export through the kit.
    pub export: Option<KitExport>,
}

/// How `<prefix>_export` writes a new file through the kit's engine (`kit.json` `agent.export`).
#[derive(Debug)]
pub struct KitExport {
    /// The command every format runs, with `format` set to the extension.
    pub command: &'static str,
    /// The formats it writes: `kit.json` `exports[].extension`.
    pub formats: &'static [&'static str],
    /// The field of the command's answer that holds the file, base64.
    pub data: &'static str,
    /// Parameters every export passes, a JSON object, so the open editor and the headless kit
    /// export the same thing (KHP A26) whatever the person has selected.
    pub params: &'static str,
}

fn leak(text: String) -> &'static str {
    Box::leak(text.into_boxed_str())
}

fn leak_all<T>(items: Vec<T>) -> &'static [T] {
    Box::leak(items.into_boxed_slice())
}

/// `.kslide`, `.kslide and .pptx`, `.a, .b, or .c`.
fn listed(extensions: &[&str]) -> String {
    let dotted: Vec<String> = extensions.iter().map(|extension| format!(".{extension}")).collect();
    match dotted.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, or {last}", rest.join(", ")),
    }
}

fn text_or(value: &Value, key: &str, otherwise: &str) -> String {
    value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).unwrap_or(otherwise).to_owned()
}

fn extension_list(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(Value::as_str).map(|e| e.trim_start_matches('.').to_ascii_lowercase()).collect()).unwrap_or_default()
}

impl KitDefinition {
    /// The kit a KHP manifest's text declares; the text is served as it is (K20).
    pub fn from_manifest_text(text: &str) -> Result<&'static Self, String> {
        let manifest: Value = serde_json::from_str(text).map_err(|error| format!("kit.json is not JSON: {error}"))?;
        Self::declared(&manifest, text.to_owned())
    }

    /// The kit a KHP manifest declares. It needs an `id`, a `name`, `agent.prefix`, and at least
    /// one format with the `edit` role.
    pub fn from_manifest(manifest: &Value) -> Result<&'static Self, String> {
        let text = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
        Self::declared(manifest, text)
    }

    fn declared(manifest: &Value, source: String) -> Result<&'static Self, String> {
        let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        let id = text(manifest, "id").ok_or("kit.json has no `id`")?;
        let name = text(manifest, "name").ok_or_else(|| format!("{id}: kit.json has no `name`"))?;
        let agent = manifest.get("agent").cloned().unwrap_or(Value::Null);
        let prefix = text(&agent, "prefix").ok_or_else(|| format!("{id}: kit.json has no `agent.prefix`"))?;
        // A tool name every model provider accepts (KHP A2): `^[a-z][a-z0-9]*$`.
        if !prefix.starts_with(|c: char| c.is_ascii_lowercase()) || !prefix.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return Err(format!("{id}: `agent.prefix` `{prefix}` is not lowercase letters and digits (KHP A2)"));
        }
        let mut extensions: Vec<String> = Vec::new();
        for format in manifest.get("formats").and_then(Value::as_array).into_iter().flatten() {
            if format.get("role").and_then(Value::as_str) == Some("edit") {
                for extension in extension_list(&format["extensions"]) {
                    if !extensions.contains(&extension) {
                        extensions.push(extension);
                    }
                }
            }
        }
        if extensions.is_empty() {
            return Err(format!("{id}: kit.json declares no `edit` format"));
        }
        let mut views: Vec<String> = Vec::new();
        for format in manifest.get("formats").and_then(Value::as_array).into_iter().flatten() {
            if format.get("role").and_then(Value::as_str) == Some("view") {
                for extension in extension_list(&format["extensions"]) {
                    if !extensions.contains(&extension) && !views.contains(&extension) {
                        views.push(extension);
                    }
                }
            }
        }
        let creates: Vec<(String, String)> = manifest
            .get("creates")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| Some((text(entry, "extension")?.trim_start_matches('.').to_ascii_lowercase(), text(entry, "id")?)))
            .collect();
        let base_name = manifest
            .get("creates")
            .and_then(Value::as_array)
            .and_then(|entries| entries.iter().find_map(|entry| text(entry, "baseName")))
            .unwrap_or_else(|| format!("Untitled {}", name.to_lowercase()));
        let export_formats = extension_list(&Value::Array(
            manifest.get("exports").and_then(Value::as_array).into_iter().flatten().filter_map(|entry| entry.get("extension").cloned()).collect(),
        ));
        let mut exports = export_formats.clone();
        for extension in extension_list(manifest.pointer("/files/create").unwrap_or(&Value::Null)) {
            if !exports.contains(&extension) {
                exports.push(extension);
            }
        }
        let describe = agent.get("describe");
        let worded = |key: &str, otherwise: String| describe.and_then(|describe| text(describe, key)).unwrap_or(otherwise);
        let extension_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
        let noun = worded("noun", format!("{} file", name.to_lowercase()));
        let formats = worded("fileTypes", listed(&extension_refs));
        let reports = worded("reports", "its contents".to_owned());
        let covers = worded("covers", format!("everything the {name} kit's commands do"));
        let queries = worded("queries", "a word from a command's title".to_owned());
        let command = worded("example", "edit.undo".to_owned());
        let render = text(&agent, "render");
        let parts = match agent.get("parts") {
            None | Some(Value::Null) => None,
            Some(Value::Array(nouns)) => {
                let nouns: Vec<String> = nouns.iter().filter_map(Value::as_str).map(str::to_owned).collect();
                let noun = |name: &String| name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_alphanumeric());
                if nouns.is_empty() || !nouns.iter().all(noun) || nouns.len() != agent["parts"].as_array().map_or(0, Vec::len) {
                    return Err(format!(
                        "{id}: `agent.parts` lists the kit's part nouns, each lowercase letters and digits in camelCase (`sequence`, `comp`, `sheetId`)"
                    ));
                }
                Some(leak_all(nouns.into_iter().map(leak).collect()))
            }
            Some(_) => return Err(format!("{id}: `agent.parts` is a list of the kit's part nouns")),
        };
        let export = match agent.get("export") {
            Some(export) => {
                let command = text(export, "command").ok_or_else(|| format!("{id}: `agent.export` has no `command`"))?;
                let data = text(export, "data").ok_or_else(|| format!("{id}: `agent.export` has no `data`"))?;
                let params = export.get("params").filter(|params| params.is_object()).cloned().unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                if export_formats.is_empty() {
                    return Err(format!("{id}: `agent.export` without `exports`"));
                }
                Some(KitExport {
                    command: leak(command),
                    formats: leak_all(export_formats.iter().cloned().map(leak).collect()),
                    data: leak(data),
                    params: leak(params.to_string()),
                })
            }
            None => None,
        };
        let definition = Self {
            id: leak(id),
            name: leak(name),
            extensions: leak_all(extensions.into_iter().map(leak).collect()),
            views: leak_all(views.into_iter().map(leak).collect()),
            creates: leak_all(creates.into_iter().map(|(extension, kind)| (leak(extension), leak(kind))).collect()),
            base_name: leak(base_name),
            exports: leak_all(exports.into_iter().map(leak).collect()),
            executable: manifest.pointer("/headless/executable").and_then(Value::as_str).map(|name| leak(name.to_owned())),
            protocol: manifest.pointer("/headless/protocol").and_then(Value::as_str).map(|protocol| leak(protocol.to_owned())),
            version: leak(text_or(manifest, "version", "0.0.0")),
            manifest: leak(source),
            outline: manifest.pointer("/outline/command").and_then(Value::as_str).filter(|command| !command.is_empty()).map(|command| leak(command.to_owned())),
            agent: KitAgent {
                prefix: leak(prefix),
                drafts: agent.get("drafts").and_then(Value::as_bool).unwrap_or(false),
                object_model: agent.get("objectModel").and_then(Value::as_bool).unwrap_or(false),
                noun: leak(noun),
                formats: leak(formats),
                reports: leak(reports),
                covers: leak(covers),
                queries: leak(queries),
                command: leak(command),
                use_for: describe.and_then(|describe| text(describe, "use")).map(leak),
                render: render.map(leak),
                parts,
                export,
            },
        };
        Ok(Box::leak(Box::new(definition)))
    }

    /// What a host tells an agent about when to make one of the kit's files, from `agent.describe.use`:
    /// ``Use a `.ktable` file through the Table kit for structured, spreadsheet-like results.`` It
    /// names the first extension the kit creates. `None` for a kit that names no use or creates
    /// nothing.
    pub fn guidance(&self) -> Option<String> {
        let (extension, _) = self.creates.first()?;
        Some(format!("Use a `.{extension}` file through the {} kit for {}.", self.name, self.agent.use_for?))
    }

    /// The kit's short name, `photo` for `kit.photo`.
    pub fn short_name(&self) -> &'static str {
        self.id.strip_prefix("kit.").unwrap_or(self.id)
    }
}

/// Every kit a manager in this process found, by id: what tool names, labels, and linked-file
/// instructions resolve against when no manager is at hand.
static KNOWN: RwLock<Vec<&'static KitDefinition>> = RwLock::new(Vec::new());

/// Adds `kits` to the kits this process knows; a kit found again replaces the earlier one.
pub fn register<'a>(kits: impl IntoIterator<Item = &'a &'static KitDefinition>) {
    let mut known = KNOWN.write().unwrap_or_else(PoisonError::into_inner);
    for kit in kits {
        known.retain(|other| other.id != kit.id);
        known.push(kit);
    }
    known.sort_by_key(|kit| kit.id);
}

/// The kits this process knows, by id.
pub fn known() -> Vec<&'static KitDefinition> {
    KNOWN.read().unwrap_or_else(PoisonError::into_inner).clone()
}

/// Where to find kits.
#[derive(Clone, Debug, Default)]
pub struct KitSources {
    /// Manifests the embedding host hands over, as JSON text.
    pub manifests: Vec<String>,
    /// A folder with one folder per kit holding its `kit.json`.
    pub kits_dir: Option<PathBuf>,
    /// Headless executables, each found with the `kit.json` it was built from.
    pub executables: Vec<PathBuf>,
}

/// The variables that name a kit's headless executable for development builds:
/// `KITION_KIT_<NAME>_BINARY`, for example `KITION_KIT_PHOTO_BINARY`.
pub const EXECUTABLE_VARIABLE: (&str, &str) = ("KITION_KIT_", "_BINARY");

impl KitSources {
    /// The executables the environment names (`KITION_KIT_<NAME>_BINARY`), for development
    /// builds that run kits from their repositories, each with the variable that names it.
    pub fn executables_from_env() -> Vec<(String, PathBuf)> {
        let (prefix, suffix) = EXECUTABLE_VARIABLE;
        let mut found: Vec<(String, PathBuf)> = std::env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.into_string().ok()?;
                let name = key.strip_prefix(prefix)?.strip_suffix(suffix)?;
                (!name.is_empty() && !value.is_empty()).then(|| (key.clone(), PathBuf::from(value)))
            })
            .collect();
        found.sort();
        found
    }
}

/// The `kit.json` an executable was built from, as its text: the nearest one above it whose
/// `headless.executable` is the executable's name (a kit repository's `target/debug/`), else, in
/// an SDK bundle (`bin/<platform>/kition-<kit>`), the bundle's `kits/<kit>/kit.json` that names it.
pub fn manifest_beside(executable: &Path) -> Option<String> {
    manifest_file_beside(executable).map(|(_, text)| text)
}

/// [`manifest_beside`], with the path of the `kit.json`.
fn manifest_file_beside(executable: &Path) -> Option<(PathBuf, String)> {
    let name = executable.file_stem()?.to_str()?;
    let names_it = |path: PathBuf| {
        let text = std::fs::read_to_string(&path).ok()?;
        let manifest: Value = serde_json::from_str(&text).ok()?;
        (manifest.pointer("/headless/executable").and_then(Value::as_str) == Some(name)).then_some((path, text))
    };
    executable.ancestors().skip(1).take(5).find_map(|folder| names_it(folder.join("kit.json"))).or_else(|| {
        let kits = executable.parent()?.parent()?.parent()?.join("kits");
        std::fs::read_dir(kits).ok()?.flatten().find_map(|entry| names_it(entry.path().join("kit.json")))
    })
}

/// What the kit executable `executable` reads under the sandbox (`kition-kits-mcp --sandbox`,
/// [`kition_kit_host::sandbox`]) besides its own folder: its package, the folder of the
/// `kit.json` beside it ([`manifest_beside`]). It gets no workspace: its files reach it as handles
/// (Kit Process Protocol section 5.1; host H14).
#[must_use]
pub fn sandbox_for(executable: &Path) -> kition_kit_host::Sandbox {
    let package = manifest_file_beside(executable).and_then(|(path, _)| path.parent().map(Path::to_path_buf));
    kition_kit_host::Sandbox { reads: package.into_iter().collect(), workspace: None }
}

/// The SDK bundle's name for this machine's platform, its `bin/<platform>/` (`darwin-arm64`,
/// `linux-x64`, `win32-x64`), as `tools/sdk-bundle.mjs` names it.
pub fn bundle_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// A kit found, with its headless executable when there is one.
pub type Found = (&'static KitDefinition, Option<PathBuf>);

/// Each id's manifest: its text, as parsed, and its executable.
type Manifests = BTreeMap<String, (String, Value, Option<PathBuf>)>;

/// Keeps the manifest `text` for its id; an executable already found for the id stays with it.
fn insert(manifests: &mut Manifests, text: String, executable: Option<PathBuf>, from: &str) {
    let manifest: Value = match serde_json::from_str(&text) {
        Ok(manifest) => manifest,
        Err(error) => {
            tracing::warn!(%from, %error, "a kit manifest that is not JSON");
            return;
        }
    };
    match manifest.get("id").and_then(Value::as_str).map(str::to_owned) {
        Some(id) => {
            let keep = executable.or_else(|| manifests.get(&id).and_then(|(_, _, executable)| executable.clone()));
            manifests.insert(id, (text, manifest, keep));
        }
        None => tracing::warn!(%from, "a kit manifest without an id"),
    }
}

/// Every kit the sources declare, by id; an executable's own manifest wins over a package's, and
/// gives the kit its executable. Manifests that do not declare a kit are skipped with a warning.
pub fn discover(sources: &KitSources) -> Vec<Found> {
    let mut manifests: Manifests = BTreeMap::new();
    for text in &sources.manifests {
        insert(&mut manifests, text.clone(), None, "the host");
    }
    if let Some(dir) = &sources.kits_dir {
        let mut paths: Vec<PathBuf> =
            std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path().join("kit.json")).filter(|path| path.is_file()).collect();
        paths.sort();
        for path in paths {
            match std::fs::read_to_string(&path) {
                Ok(text) => insert(&mut manifests, text, None, &path.display().to_string()),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "a kit manifest that cannot be read")
                }
            }
        }
    }
    for executable in &sources.executables {
        match manifest_beside(executable) {
            Some(text) => insert(&mut manifests, text, Some(executable.clone()), &executable.display().to_string()),
            None => {
                // An executable without its repository's manifest: the package's kit, matched by
                // the executable's name.
                let name = executable.file_stem().and_then(|name| name.to_str()).unwrap_or_default();
                let owner = manifests.iter_mut().find(|(_, (_, manifest, _))| manifest.pointer("/headless/executable").and_then(Value::as_str) == Some(name));
                match owner {
                    Some((_, (_, _, slot))) => *slot = Some(executable.clone()),
                    None => {
                        tracing::warn!(executable = %executable.display(), "no kit manifest names this executable")
                    }
                }
            }
        }
    }
    manifests
        .into_iter()
        .filter_map(|(id, (text, manifest, executable))| match KitDefinition::declared(&manifest, text) {
            Ok(definition) => Some((definition, executable)),
            Err(error) => {
                tracing::warn!(%id, %error, "a kit manifest that declares no usable kit");
                None
            }
        })
        .collect()
}

/// An executable given at startup: by `--kit`, or by the variable that names it.
struct Given {
    path: PathBuf,
    variable: Option<String>,
}

impl Given {
    /// How the person gave it: `--kit <path>`, or `KITION_KIT_<KIT>_BINARY=<path>`.
    fn source(&self) -> String {
        match &self.variable {
            Some(variable) => format!("{variable}={}", self.path.display()),
            None => format!("--kit {}", self.path.display()),
        }
    }
}

/// The kits a program's options and the environment declare, the same for `kition-kits serve` and
/// `kition-kits-mcp`: `executables` (`--kit`) and the environment's `KITION_KIT_<KIT>_BINARY`,
/// each with the manifest it was built from (in a kit repository, or in an SDK bundle); the kit
/// folders in `kits_dir`, each with its executable beside its `kit.json` when installed. For kits
/// found without an executable, the one their `kit.json` names in the bundle's
/// `bin/<platform>/` beside `kits_dir`, beside the running program, and on the PATH.
///
/// An executable given by `--kit` or a variable that no kit.json names (`headless.executable`) is
/// asked which kit it is (`kit.initialize`), and takes that kit's manifest: the one found, or the
/// nearest kit.json above it with that id. One that is missing, cannot be asked, reports a kit no
/// manifest declares, or reports another kit than its variable names is an error: the program
/// must not start without the kit it was given (KHP A48: the error names the path, what was
/// expected, and the kits known). With `sandbox`, an executable is asked under the sandbox
/// ([`sandbox_for`]), as the manager runs it (`KitManager::with_sandbox`).
pub fn found(executables: &[PathBuf], kits_dir: Option<&Path>, sandbox: bool, limits: crate::control::Limits) -> Result<Vec<Found>, String> {
    limits.validate()?;
    let mut given: Vec<Given> = executables.iter().map(|path| Given { path: path.clone(), variable: None }).collect();
    given.extend(KitSources::executables_from_env().into_iter().map(|(variable, path)| Given { path, variable: Some(variable) }));
    let mut errors: Vec<String> = given.iter().filter(|given| !given.path.is_file()).map(|given| format!("{}: no such file", given.source())).collect();
    let mut executables: Vec<PathBuf> = given.iter().map(|given| given.path.clone()).filter(|path| path.is_file()).collect();
    if let Some(dir) = kits_dir {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let manifest = std::fs::read_to_string(entry.path().join("kit.json")).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
            if let Some(name) = manifest.as_ref().and_then(|manifest| manifest.pointer("/headless/executable")).and_then(Value::as_str) {
                let executable = entry.path().join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
                if executable.is_file() {
                    executables.push(executable);
                }
            }
        }
    }
    let mut found = discover(&KitSources { manifests: Vec::new(), kits_dir: kits_dir.map(Path::to_path_buf), executables });
    for given in given.iter().filter(|given| given.path.is_file()) {
        if let Err(error) = place(given, &mut found, sandbox, limits) {
            errors.push(error);
        }
    }
    if !errors.is_empty() {
        let known: Vec<String> = found.iter().map(|(kit, _)| format!("{} ({})", kit.id, kit.name)).collect();
        let known = if known.is_empty() {
            "no kit is known: give --kits-dir <folder>, or an executable inside its kit repository".to_owned()
        } else {
            format!("the kits known are {}", known.join(", "))
        };
        return Err(format!("{}\n{known}", errors.join("\n")));
    }
    if let Some(bin) = kits_dir.and_then(Path::parent).map(|bundle| bundle.join("bin").join(bundle_platform())) {
        in_folder(&mut found, &bin);
    }
    if let Some(own) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        in_folder(&mut found, &own);
    }
    on_path(&mut found);
    Ok(found)
}

/// Adds the kits of a store (`kition`'s) to those `found` from the options and the environment:
/// a kit found with an executable keeps it; a kit found without one takes the store's.
pub fn merge(found: &mut Vec<Found>, stored: Vec<Found>) {
    for (kit, executable) in stored {
        match found.iter_mut().find(|(known, _)| known.id == kit.id) {
            Some((_, Some(_))) => {}
            Some(slot) => *slot = (kit, executable),
            None => found.push((kit, executable)),
        }
    }
    found.sort_by_key(|(kit, _)| kit.id);
}

/// Gives the kit a `given` executable is its executable: the one whose kit.json names it, else
/// the one it reports when asked (`kit.initialize`). Errs, saying why, when it is neither, or when
/// it is another kit than its variable names.
fn place(given: &Given, found: &mut Vec<Found>, sandbox: bool, limits: crate::control::Limits) -> Result<(), String> {
    let source = given.source();
    let expected = given.variable.as_deref().map(|variable| {
        let (prefix, suffix) = EXECUTABLE_VARIABLE;
        let name = variable.strip_prefix(prefix).and_then(|rest| rest.strip_suffix(suffix)).unwrap_or(variable);
        format!("kit.{}", name.to_lowercase())
    });
    let differs = |id: &str| {
        let variable = given.variable.as_deref()?;
        (env_variable(id) != variable).then(|| {
            format!("{source}: the executable is {id}, and {variable} is for {}: name it with {}", expected.as_deref().unwrap_or_default(), env_variable(id))
        })
    };
    if let Some((kit, _)) = found.iter().find(|(_, executable)| executable.as_deref() == Some(given.path.as_path())) {
        return differs(kit.id).map_or(Ok(()), Err);
    }
    let name = given.path.file_stem().and_then(|name| name.to_str()).unwrap_or_default();
    let (id, version) = ask(&given.path, sandbox, limits).map_err(|reason| {
        format!(
            "{source}: cannot tell which kit this is: no kit.json above it or in --kits-dir names `{name}` as its headless.executable{}, and asking it (kit.initialize) failed: {reason}",
            expected.as_deref().map(|id| format!(" (expected {id})")).unwrap_or_default()
        )
    })?;
    if let Some(error) = differs(&id) {
        return Err(error);
    }
    if let Some((_, executable)) = found.iter_mut().find(|(kit, _)| kit.id == id) {
        *executable = Some(given.path.clone());
        return Ok(());
    }
    let above = given.path.ancestors().skip(1).take(5).find_map(|folder| {
        let text = std::fs::read_to_string(folder.join("kit.json")).ok()?;
        let manifest: Value = serde_json::from_str(&text).ok()?;
        (manifest.get("id").and_then(Value::as_str) == Some(id.as_str())).then_some((manifest, text))
    });
    match above {
        Some((manifest, text)) => {
            let kit = KitDefinition::declared(&manifest, text).map_err(|error| format!("{source}: its kit.json ({id}) declares no usable kit: {error}"))?;
            found.push((kit, Some(given.path.clone())));
            Ok(())
        }
        None => Err(format!("{source}: the executable is {id} {version}, and no kit.json for {id} is above it or in --kits-dir")),
    }
}

/// Asks the kit executable at `path` which kit it is: starts it, answers its `kit.initialize`
/// (`kit.id`, `kit.version`), and stops it, under the sandbox with `sandbox`. Runs on its own
/// thread, so it works from any caller.
fn ask(path: &Path, sandbox: bool, limits: crate::control::Limits) -> Result<(String, String), String> {
    let mut options = kition_kit_host::LaunchOptions::new(path);
    options.sandbox = sandbox.then(|| sandbox_for(path));
    options.memory_limit_bytes = limits.memory_limit_bytes;
    options.ready_timeout = options.ready_timeout.min(limits.call_timeout);
    options.initialize_timeout = limits.deadline("kit.initialize");
    let asked = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
        runtime.block_on(async move {
            let kit = kition_kit_host::HeadlessKit::launch(options).await.map_err(|error| error.to_string())?;
            let answer = (kit.kit_id().to_owned(), kit.kit_version().to_owned());
            kit.shutdown(std::time::Duration::from_secs(2)).await;
            if answer.0.is_empty() { Err("it answered no kit id".to_owned()) } else { Ok(answer) }
        })
    });
    asked.join().unwrap_or_else(|_| Err("asking it failed".to_owned()))
}

/// Why a found kit has no executable, for the person starting the program: where it was looked
/// for. `None` for a kit that has one.
pub fn missing(found: &Found) -> Option<String> {
    let (kit, executable) = found;
    if executable.is_some() {
        return None;
    }
    Some(match kit.executable {
        None => format!("{} ({}) names no headless executable in its kit.json", kit.id, kit.name),
        Some(name) => format!(
            "{} ({}) has no executable: no {name} from --kit or {}, in the bundle's bin/{}/, beside this program, or on the PATH",
            kit.id,
            kit.name,
            env_variable(kit.id),
            bundle_platform()
        ),
    })
}

/// `KITION_KIT_<KIT>_BINARY` for `kit.<kit>`.
fn env_variable(id: &str) -> String {
    let (prefix, suffix) = EXECUTABLE_VARIABLE;
    format!("{prefix}{}{suffix}", id.rsplit('.').next().unwrap_or(id).to_uppercase())
}

/// The executable each found kit's `kit.json` names, in `folder` (an SDK bundle's
/// `bin/<platform>/`, beside `kition-kits` itself), for kits found without one.
pub fn in_folder(found: &mut [Found], folder: &Path) {
    for (kit, executable) in found.iter_mut().filter(|(_, executable)| executable.is_none()) {
        let Some(name) = kit.executable else { continue };
        let candidate = folder.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        *executable = candidate.is_file().then_some(candidate);
    }
}

/// The `kition-<name>` executables on `PATH` for kits found without one, by the name their
/// manifest gives (`headless.executable`).
pub fn on_path(found: &mut [Found]) {
    let Some(path) = std::env::var_os("PATH") else {
        return;
    };
    for (kit, executable) in found.iter_mut().filter(|(_, executable)| executable.is_none()) {
        let Some(name) = kit.executable else { continue };
        *executable = std::env::split_paths(&path).map(|dir| dir.join(name)).find(|candidate| candidate.is_file());
    }
}

/// The fixture kits, registered: the published kits' manifests (`tests/fixtures/kits`, copied by
/// `tools/sync-kit-fixtures.mjs`), for tests here and in the crates that use these tools (feature
/// `test-kits`).
#[cfg(any(test, feature = "test-kits"))]
pub fn fixture_kits() -> Vec<&'static KitDefinition> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut paths: Vec<PathBuf> = std::fs::read_dir(root.join("tests/fixtures/kits")).into_iter().flatten().flatten().map(|entry| entry.path()).collect();
    paths.sort();
    let kits: Vec<&'static KitDefinition> =
        paths.iter().filter_map(|path| std::fs::read_to_string(path).ok()).filter_map(|text| KitDefinition::from_manifest_text(&text).ok()).collect();
    register(kits.iter());
    kits
}

/// The fixture kit with `id` (`kit.photo`).
#[cfg(any(test, feature = "test-kits"))]
pub fn fixture_kit(id: &str) -> &'static KitDefinition {
    match fixture_kits().into_iter().find(|kit| kit.id == id) {
        Some(kit) => kit,
        None => panic!("{id} is not one of the fixture kits"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({
            "id": "kit.sample", "name": "Sample", "version": "1.0.0",
            "formats": [
                { "id": "sample", "extensions": ["ksample"], "role": "edit" },
                { "id": "sample-import", "extensions": ["svg"], "role": "view" }
            ],
            "creates": [{ "id": "sample", "extension": "ksample", "baseName": "Untitled sample", "size": { "width": 10, "height": 10 } }],
            "exports": [{ "extension": "png" }],
            "files": { "create": ["png", "jpg"] },
            "agent": {
                "prefix": "sample",
                "describe": { "noun": "sample drawing", "fileTypes": ".ksample", "reports": "its shapes", "covers": "shapes", "queries": "`circle`", "example": "shape.circle" },
                "render": "file.render",
                "export": { "command": "file.exportBytes", "data": "data", "params": { "ids": [] } }
            },
            "headless": { "executable": "kit-sample" }
        })
    }

    #[test]
    fn a_definition_is_what_the_manifest_declares() {
        let kit = KitDefinition::from_manifest(&manifest()).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!((kit.id, kit.name, kit.short_name()), ("kit.sample", "Sample", "sample"));
        assert_eq!(kit.extensions, ["ksample"], "only the edit formats open in the kit");
        assert_eq!(kit.views, ["svg"], "the view formats open read-only");
        assert_eq!(kit.creates, [("ksample", "sample")]);
        assert_eq!(kit.base_name, "Untitled sample");
        assert_eq!(kit.exports, ["png", "jpg"], "exports and the files it creates beside its documents");
        assert_eq!(kit.executable, Some("kit-sample"));
        assert_eq!((kit.agent.prefix, kit.agent.noun, kit.agent.command, kit.agent.render), ("sample", "sample drawing", "shape.circle", Some("file.render")));
        let Some(export) = &kit.agent.export else { panic!("agent.export is read") };
        assert_eq!((export.command, export.formats, export.data, export.params), ("file.exportBytes", &["png"][..], "data", r#"{"ids":[]}"#));
    }

    #[test]
    fn a_format_the_kit_edits_is_no_view_format_too() {
        let mut both = manifest();
        both["formats"] = json!([
            { "id": "a", "extensions": ["ksample", "html"], "role": "edit" },
            { "id": "b", "extensions": ["html", "htm", "svg"], "role": "view" },
            { "id": "c", "extensions": ["svg"], "role": "view" }
        ]);
        let kit = KitDefinition::from_manifest(&both).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(kit.views, ["htm", "svg"]);
    }

    #[test]
    fn a_kit_says_what_an_agent_makes_its_files_for() {
        let mut used = manifest();
        used["agent"]["describe"]["use"] = json!("sample drawings");
        used["creates"] = json!([{ "id": "sample", "extension": "ksample", "baseName": "Untitled sample", "size": { "width": 1, "height": 1 } }]);
        let kit = KitDefinition::from_manifest(&used).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(kit.agent.use_for, Some("sample drawings"));
        assert_eq!(kit.guidance().as_deref(), Some(format!("Use a `.ksample` file through the {} kit for sample drawings.", kit.name).as_str()));
        // A kit that names no use, or creates nothing, gives no guidance.
        let mut silent = used.clone();
        silent["agent"]["describe"].as_object_mut().unwrap_or_else(|| panic!("describe")).remove("use");
        assert_eq!(KitDefinition::from_manifest(&silent).unwrap_or_else(|error| panic!("{error}")).guidance(), None);
        let mut creates_nothing = used;
        creates_nothing["creates"] = json!([]);
        assert_eq!(KitDefinition::from_manifest(&creates_nothing).unwrap_or_else(|error| panic!("{error}")).guidance(), None);
    }

    #[test]
    fn a_manifest_without_wording_is_worded_from_its_name_and_formats() {
        let mut bare = manifest();
        bare["agent"] = json!({ "prefix": "sample" });
        bare["formats"][0]["extensions"] = json!(["ksample", "pptx"]);
        let kit = KitDefinition::from_manifest(&bare).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!((kit.agent.noun, kit.agent.formats, kit.agent.command), ("sample file", ".ksample and .pptx", "edit.undo"));
        assert!(kit.agent.render.is_none() && kit.agent.export.is_none());
    }

    #[test]
    fn a_manifest_that_declares_no_kit_is_refused() {
        for (pointer, why) in [("/id", "id"), ("/agent/prefix", "agent.prefix")] {
            let mut broken = manifest();
            if let Some(field) = broken.pointer_mut(pointer) {
                *field = Value::Null;
            }
            assert!(KitDefinition::from_manifest(&broken).is_err_and(|error| error.contains(why)), "{why}");
        }
        let mut viewer = manifest();
        viewer["formats"] = json!([{ "id": "sample", "extensions": ["svg"], "role": "view" }]);
        assert!(KitDefinition::from_manifest(&viewer).is_err());
    }

    #[test]
    fn an_executable_brings_the_manifest_it_was_built_from_and_wins_over_a_package() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let packages = root.path().join("packages/sample-ui");
        std::fs::create_dir_all(&packages).unwrap_or_else(|error| panic!("{error}"));
        let mut packaged = manifest();
        packaged["name"] = json!("Old Sample");
        std::fs::write(packages.join("kit.json"), packaged.to_string()).unwrap_or_else(|error| panic!("{error}"));
        let repository = root.path().join("kition-sample");
        let build = repository.join("target/debug");
        std::fs::create_dir_all(&build).unwrap_or_else(|error| panic!("{error}"));
        std::fs::write(repository.join("kit.json"), manifest().to_string()).unwrap_or_else(|error| panic!("{error}"));
        let executable = build.join("kit-sample");
        std::fs::write(&executable, b"").unwrap_or_else(|error| panic!("{error}"));
        let mut other = manifest();
        other["id"] = json!("kit.other");
        other["agent"]["prefix"] = json!("other");
        other["headless"]["executable"] = json!("kit-other");
        let found = discover(&KitSources {
            manifests: vec![other.to_string(), "not json".into()],
            kits_dir: Some(root.path().join("packages")),
            executables: vec![executable.clone()],
        });
        let summary: Vec<(&str, &str, bool)> = found.iter().map(|(kit, executable)| (kit.id, kit.name, executable.is_some())).collect();
        assert_eq!(summary, [("kit.other", "Sample", false), ("kit.sample", "Sample", true)]);
        assert_eq!(found[1].1.as_deref(), Some(executable.as_path()));
    }

    /// a sandboxed kit reads its package, the folder of the `kit.json` beside its executable,
    /// in a kit repository and in an SDK bundle, and gets no workspace (its files come as handles).
    #[test]
    fn a_sandboxed_kit_reads_the_package_of_its_manifest() {
        let root = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        fn write(path: &Path, text: &str) {
            std::fs::create_dir_all(path.parent().unwrap_or(path)).unwrap_or_else(|error| panic!("{error}"));
            std::fs::write(path, text).unwrap_or_else(|error| panic!("{error}"));
        }
        let repository = root.path().join("kition-sample");
        write(&repository.join("kit.json"), &manifest().to_string());
        let built = repository.join("target/debug/kit-sample");
        write(&built, "");
        assert_eq!(sandbox_for(&built), kition_kit_host::Sandbox { reads: vec![repository.clone()], workspace: None });

        let bundle = root.path().join("bundle");
        let package = bundle.join("kits/sample");
        write(&package.join("kit.json"), &manifest().to_string());
        let bundled = bundle.join("bin").join(bundle_platform()).join("kit-sample");
        write(&bundled, "");
        assert_eq!(sandbox_for(&bundled).reads, [package]);

        let stray = root.path().join("loose/kit-stray");
        write(&stray, "");
        assert_eq!(sandbox_for(&stray), kition_kit_host::Sandbox::default());
    }

    #[test]
    fn extensions_read_as_people_list_them() {
        assert_eq!(listed(&["kdesign"]), ".kdesign");
        assert_eq!(listed(&["kslide", "pptx"]), ".kslide and .pptx");
        assert_eq!(listed(&["psd", "psb", "kphoto"]), ".psd, .psb, or .kphoto");
    }
}
