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
