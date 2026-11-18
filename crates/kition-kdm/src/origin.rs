// Copied from kition-sdk crates/kition-kdm/src/origin.rs by scripts/sync-kit-host.mjs; change it there, not here.
/// Who caused a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum OriginKind {
    Person,
    Agent,
    Extension,
    Import,
    System,
}

impl OriginKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Agent => "agent",
            Self::Extension => "extension",
            Self::Import => "import",
            Self::System => "system",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "person" => Self::Person,
            "agent" => Self::Agent,
            "extension" => Self::Extension,
            "import" => Self::Import,
            "system" => Self::System,
            _ => return None,
        })
    }
}

/// The undo history a transaction joins (rule M12a): a person's undo and an agent's undo on one
/// replica each take back only their own steps, and keep the other's like another replica's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UndoScope {
    /// The person at the replica, and the scripts and extensions they run.
    Person,
    /// The agents working for that person on the replica.
    Agent,
}

impl UndoScope {
    /// The scope of a transaction of `kind`; `None` for `import` and `system`, which are no undo step.
    pub fn of(kind: OriginKind) -> Option<Self> {
        match kind {
            OriginKind::Person | OriginKind::Extension => Some(Self::Person),
            OriginKind::Agent => Some(Self::Agent),
            OriginKind::Import | OriginKind::System => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Agent => "agent",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "person" => Self::Person,
            "agent" => Self::Agent,
            _ => return None,
        })
    }
}

/// The origin of a transaction: its kind, the principal it acts for, and a label for history.
/// Authorization never trusts it; a server checks the authenticated principal instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub kind: OriginKind,
    pub principal: String,
    pub label: Option<String>,
}

impl Origin {
    pub fn new(kind: OriginKind, principal: impl Into<String>) -> Self {
        Self { kind, principal: principal.into(), label: None }
    }

    pub fn person(principal: impl Into<String>) -> Self {
        Self::new(OriginKind::Person, principal)
    }

    pub fn agent(principal: impl Into<String>) -> Self {
        Self::new(OriginKind::Agent, principal)
    }

    pub fn system(label: impl Into<String>) -> Self {
        Self::new(OriginKind::System, "kdm").with_label(label)
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The commit message form: a JSON array `[kind, principal, label]`.
    pub fn encode(&self) -> String {
        serde_json::json!([self.kind.as_str(), self.principal, self.label]).to_string()
    }

    /// The commit message of every transaction (standard 2.0 rule M5a): the origin and the schema
    /// version of the replica that made it, a JSON array `[kind, principal, label, schemaVersion]`,
    /// identical to the TypeScript encoding. [`Origin::decode`] reads it too (it reads the first
    /// three elements); a message written before rule M5a has no fourth element.
    pub fn encode_commit(&self, schema_version: u32) -> String {
        serde_json::json!([self.kind.as_str(), self.principal, self.label, schema_version]).to_string()
    }

    /// A commit message's origin and author schema version (`None` when the message predates rule
    /// M5a or names none), or `None` when the message is not a KDM commit message.
    pub fn decode_commit(text: &str) -> Option<(Self, Option<u32>)> {
        let origin = Self::decode(text)?;
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let version = value.as_array()?.get(3).and_then(serde_json::Value::as_u64).and_then(|version| u32::try_from(version).ok());
        Some((origin, version))
    }

    pub fn decode(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let parts = value.as_array()?;
        Some(Self {
            kind: OriginKind::parse(parts.first()?.as_str()?)?,
            principal: parts.get(1)?.as_str()?.to_owned(),
            label: parts.get(2).and_then(|label| label.as_str()).map(str::to_owned),
        })
    }
}
