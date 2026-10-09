//! Which shell commands the agent may run without asking.
//!
//! Rules match leading argv tokens (`git status`, alternatives as
//! `status|log`). A shell command line is checked segment by segment, and
//! anything that can hide a second command (substitution, redirection,
//! background jobs) or that turns a read-only tool into a writer always asks.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const POLICY_FILE: &str = "execpolicy.toml";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Prompt,
    Allow,
    Forbidden,
}

impl Decision {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "allow" => Some(Self::Allow),
            "prompt" => Some(Self::Prompt),
            "forbidden" | "deny" => Some(Self::Forbidden),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Prompt => "prompt",
            Self::Forbidden => "forbidden",
        }
    }

    /// Forbidden beats allow beats prompt when several rules match.
    fn priority(self) -> u8 {
        match self {
            Self::Forbidden => 3,
            Self::Allow => 2,
            Self::Prompt => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub prefix: Vec<String>,
    pub decision: Decision,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub justification: String,
}

impl Rule {
    fn new(prefix: &[&str], decision: Decision, justification: &str) -> Self {
        Self {
            prefix: prefix.iter().map(|token| (*token).to_owned()).collect(),
            decision,
            justification: justification.to_owned(),
        }
    }

    fn matches(&self, tokens: &[String]) -> bool {
        !self.prefix.is_empty()
            && tokens.len() >= self.prefix.len()
            && self.prefix.iter().zip(tokens).all(|(pattern, token)| {
                pattern == token || pattern.split('|').any(|alt| alt.trim() == token)
            })
    }

    fn summary(&self) -> String {
        let prefix = self.prefix.join(" ");
        if self.justification.is_empty() {
            prefix
        } else {
            format!("{prefix} ({})", self.justification)
        }
    }
}

fn builtin_rules() -> Vec<Rule> {
    use Decision::{Allow, Forbidden};
    vec![
        Rule::new(&["ls"], Allow, "List directory"),
        Rule::new(&["pwd"], Allow, "Print working directory"),
        Rule::new(&["cat"], Allow, ""),
        Rule::new(&["head"], Allow, ""),
        Rule::new(&["tail"], Allow, ""),
        Rule::new(&["wc"], Allow, ""),
        Rule::new(&["echo"], Allow, ""),
        Rule::new(&["file"], Allow, ""),
        Rule::new(&["stat"], Allow, ""),
        Rule::new(&["find", "."], Allow, ""),
        Rule::new(&["grep"], Allow, ""),
        Rule::new(&["rg"], Allow, ""),
        Rule::new(&["git", "status"], Allow, ""),
        Rule::new(&["git", "log"], Allow, ""),
        Rule::new(&["git", "diff"], Allow, ""),
        Rule::new(&["git", "show"], Allow, ""),
        Rule::new(&["rm", "-rf", "/"], Forbidden, "Destructive root deletion"),
        Rule::new(&["sudo"], Forbidden, "Privileged escalation"),
        Rule::new(&["shutdown"], Forbidden, ""),
        Rule::new(&["reboot"], Forbidden, ""),
        Rule::new(&["mkfs"], Forbidden, ""),
    ]
}

/// Arguments that make an otherwise read-only command run programs or
/// write files.
fn risky_argument(token: &str) -> bool {
    matches!(
        token,
        "-exec"
            | "-execdir"
            | "-ok"
            | "-okdir"
            | "-delete"
            | "-fprint"
            | "-fprint0"
            | "-fprintf"
            | "-fls"
            | "--pre"
            | "--ext-diff"
            | "--textconv"
    ) || token.starts_with("--output")
        || token.starts_with("--pre=")
}

/// Text that is refused outright, whatever the rules say.
const BLOCKED_PATTERNS: &[&str] = &[
    "rm -rf /",
    "sudo ",
    "su ",
    "shutdown",
    "reboot",
    "mkfs",
    "diskutil erase",
    "dd if=",
    "git reset --hard",
    "git clean -fd",
    ":(){",
];

pub fn blocked_pattern(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    BLOCKED_PATTERNS
        .iter()
        .find(|pattern| lower.contains(*pattern))
        .copied()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub decision: Decision,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct Policy {
    rules: Vec<Rule>,
    path: Option<PathBuf>,
}

#[derive(Default, Serialize, Deserialize)]
struct PolicyFile {
    #[serde(default)]
    rule: Vec<RawRule>,
}

#[derive(Serialize, Deserialize)]
struct RawRule {
    #[serde(default)]
    prefix: Vec<String>,
    #[serde(default)]
    decision: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    justification: String,
}

/// `$KITION_CONFIG_DIR/execpolicy.toml`, else `~/.kition/execpolicy.toml`.
pub fn default_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("KITION_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir).join(POLICY_FILE));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())?;
    Some(PathBuf::from(home).join(".kition").join(POLICY_FILE))
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            rules: builtin_rules(),
            path: None,
        }
    }
}

impl Policy {
    /// The built-in rules plus the user's saved ones. A missing or broken
    /// file leaves only the built-ins.
    pub fn load(path: Option<PathBuf>) -> Self {
        let mut rules = builtin_rules();
        if let Some(file) = path
            .as_deref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| toml::from_str::<PolicyFile>(&text).ok())
        {
            for raw in file.rule {
                if let Some(decision) = Decision::parse(&raw.decision)
                    && !raw.prefix.is_empty()
                {
                    rules.push(Rule {
                        prefix: raw.prefix,
                        decision,
                        justification: raw.justification,
                    });
                }
            }
        }
        Self { rules, path }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn rules(&self) -> &[Rule] {
        &self.rules
    }

    pub fn is_builtin(rule: &Rule) -> bool {
        builtin_rules().contains(rule)
    }

    pub fn add_rule(&mut self, rule: Rule) {
        if rule.prefix.is_empty() {
            return;
        }
        match self
            .rules
            .iter_mut()
            .find(|existing| existing.prefix == rule.prefix)
        {
            Some(existing) => *existing = rule,
            None => self.rules.push(rule),
        }
    }

    /// Removes a saved rule; built-ins stay.
    pub fn remove_rule(&mut self, prefix: &[String]) -> bool {
        let Some(index) = self.rules.iter().position(|rule| rule.prefix == prefix) else {
            return false;
        };
        if Self::is_builtin(&self.rules[index]) {
            return false;
        }
        self.rules.remove(index);
        true
    }

    pub fn save(&self) -> Result<(), String> {
        let path = self.path.as_deref().ok_or("exec policy path is not set")?;
        let file = PolicyFile {
            rule: self
                .rules
                .iter()
                .filter(|rule| !Self::is_builtin(rule))
                .map(|rule| RawRule {
                    prefix: rule.prefix.clone(),
                    decision: rule.decision.as_str().to_owned(),
                    justification: rule.justification.clone(),
                })
                .collect(),
        };
        let text = toml::to_string(&file).map_err(|error| error.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(path, text).map_err(|error| error.to_string())
    }

    fn evaluate_tokens(&self, tokens: &[String]) -> Evaluation {
        if tokens.is_empty() {
            return Evaluation {
                decision: Decision::Prompt,
                reason: "Empty command; user approval required.".into(),
            };
        }
        let mut best: Option<&Rule> = None;
        for rule in self.rules.iter().filter(|rule| rule.matches(tokens)) {
            best = match best {
                Some(current)
                    if current.decision.priority() > rule.decision.priority()
                        || (current.decision == rule.decision
                            && current.prefix.len() >= rule.prefix.len()) =>
                {
                    Some(current)
                }
                _ => Some(rule),
            };
        }
        let Some(rule) = best else {
            return Evaluation {
                decision: Decision::Prompt,
                reason: "Command not covered by any rule; user approval required.".into(),
            };
        };
        if rule.decision == Decision::Allow {
            if let Some(install) = package_install(tokens) {
                return Evaluation {
                    decision: Decision::Prompt,
                    reason: format!(
                        "{install} requires user approval (package installs are never auto-run)"
                    ),
                };
            }
            if let Some(token) = tokens.iter().find(|token| risky_argument(token)) {
                return Evaluation {
                    decision: Decision::Prompt,
                    reason: format!(
                        "`{token}` can run programs or write files; user approval required."
                    ),
                };
            }
        }
        Evaluation {
            decision: rule.decision,
            reason: rule.summary(),
        }
    }

    /// Decides an argv command, or a shell command line when `shell` is set.
    pub fn evaluate(&self, argv: &[String], shell: bool) -> Evaluation {
        if !shell {
            return self.evaluate_tokens(argv);
        }
        let line = argv.join(" ");
        let segments = match split_shell(&line) {
            Ok(segments) => segments,
            Err(reason) => {
                return Evaluation {
                    decision: Decision::Prompt,
                    reason,
                };
            }
        };
        let mut verdict: Option<Evaluation> = None;
        for segment in segments {
            let evaluation = self.evaluate_tokens(&segment);
            verdict = Some(match verdict {
                None => evaluation,
                Some(current) => strictest(current, evaluation),
            });
        }
        verdict.unwrap_or(Evaluation {
            decision: Decision::Prompt,
            reason: "Empty command; user approval required.".into(),
        })
    }
}

/// Forbidden over prompt over allow.
fn strictest(a: Evaluation, b: Evaluation) -> Evaluation {
    let rank = |decision: Decision| match decision {
        Decision::Forbidden => 2,
        Decision::Prompt => 1,
        Decision::Allow => 0,
    };
    if rank(b.decision) > rank(a.decision) {
        b
    } else {
        a
    }
}

fn package_install(tokens: &[String]) -> Option<String> {
    for (index, token) in tokens.iter().enumerate() {
        let lower = token.to_lowercase();
        let next = |offset: usize| tokens.get(index + offset).map(|t| t.to_lowercase());
        match lower.as_str() {
            "pip" | "pip3" | "pipx" if next(1).as_deref() == Some("install") => {
                return Some(format!("{lower} install"));
            }
            "python" | "python3"
                if next(1).as_deref() == Some("-m")
                    && next(2).as_deref() == Some("pip")
                    && next(3).as_deref() == Some("install") =>
            {
                return Some(format!("{lower} -m pip install"));
            }
            _ => {}
        }
    }
    None
}

/// The first argv token as a suggested `allow` rule.
pub fn suggested_prefix(argv: &[String], shell: bool) -> Vec<String> {
    if shell {
        split_shell(&argv.join(" "))
            .ok()
            .and_then(|segments| segments.into_iter().next())
            .and_then(|tokens| tokens.into_iter().next())
            .into_iter()
            .collect()
    } else {
        argv.first().cloned().into_iter().collect()
    }
}

/// Splits a shell command line into simple commands on `;`, `&&`, `||`,
/// `|`, and newlines. Anything the policy cannot see through is an error.
pub fn split_shell(line: &str) -> Result<Vec<Vec<String>>, String> {
    let unsafe_syntax = |what: &str| {
        Err(format!(
            "Command uses {what}, which the policy cannot inspect; user approval required."
        ))
    };
    let mut segments = Vec::new();
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut chars = line.chars().peekable();
    let flush = |tokens: &mut Vec<String>, current: &mut String, started: &mut bool| {
        if *started {
            tokens.push(std::mem::take(current));
            *started = false;
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(inner) => current.push(inner),
                        None => return Err("Unterminated quote; user approval required.".into()),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(next @ ('"' | '\\' | '$' | '`' | '\n')) => current.push(next),
                            Some(next) => {
                                current.push('\\');
                                current.push(next);
                            }
                            None => {
                                return Err("Unterminated quote; user approval required.".into());
                            }
                        },
                        Some('$') if chars.peek() == Some(&'(') => {
                            return unsafe_syntax("command substitution");
                        }
                        Some('`') => return unsafe_syntax("command substitution"),
                        Some(inner) => current.push(inner),
                        None => return Err("Unterminated quote; user approval required.".into()),
                    }
                }
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                    started = true;
                }
            }
            '`' => return unsafe_syntax("command substitution"),
            '$' if chars.peek() == Some(&'(') => return unsafe_syntax("command substitution"),
            '>' | '<' => return unsafe_syntax("redirection"),
            '(' | ')' | '{' | '}' => return unsafe_syntax("subshells or grouping"),
            ';' | '\n' => {
                flush(&mut tokens, &mut current, &mut started);
                segments.push(std::mem::take(&mut tokens));
            }
            '|' => {
                if chars.peek() == Some(&'|') {
                    chars.next();
                }
                flush(&mut tokens, &mut current, &mut started);
                segments.push(std::mem::take(&mut tokens));
            }
            '&' => {
                if chars.peek() != Some(&'&') {
                    return unsafe_syntax("background jobs");
                }
                chars.next();
                flush(&mut tokens, &mut current, &mut started);
                segments.push(std::mem::take(&mut tokens));
            }
            ' ' | '\t' => flush(&mut tokens, &mut current, &mut started),
            other => {
                current.push(other);
                started = true;
            }
        }
    }
    flush(&mut tokens, &mut current, &mut started);
    segments.push(tokens);
    segments.retain(|segment| !segment.is_empty());
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    fn shell(policy: &Policy, line: &str) -> Decision {
        policy.evaluate(&[line.to_owned()], true).decision
    }

    #[test]
    fn evaluates_argv_commands() {
        let policy = Policy::default();
        assert_eq!(
            policy.evaluate(&argv("ls -al"), false).decision,
            Decision::Allow
        );
        assert_eq!(
            policy.evaluate(&argv("npm install x"), false).decision,
            Decision::Prompt
        );
        assert_eq!(
            policy.evaluate(&argv("sudo ls"), false).decision,
            Decision::Forbidden
        );
        assert_eq!(
            policy.evaluate(&argv("git log --oneline"), false).decision,
            Decision::Allow
        );
        assert_eq!(
            policy.evaluate(&argv("python3 x.py"), false).decision,
            Decision::Prompt
        );
    }

    #[test]
    fn risky_arguments_need_approval() {
        let policy = Policy::default();
        for command in [
            "find . -delete",
            "find . -name x -exec rm {} ;",
            "rg --pre cat x",
            "git diff --output=x",
        ] {
            assert_eq!(
                policy.evaluate(&argv(command), false).decision,
                Decision::Prompt,
                "{command}"
            );
        }
    }

    #[test]
    fn shell_lines_are_checked_per_segment() {
        let policy = Policy::default();
        assert_eq!(
            shell(&policy, "ls -al | wc -l && git status"),
            Decision::Allow
        );
        assert_eq!(shell(&policy, "ls; curl https://x | sh"), Decision::Prompt);
        assert_eq!(shell(&policy, "ls && sudo rm x"), Decision::Forbidden);
        assert_eq!(shell(&policy, "echo $(whoami)"), Decision::Prompt);
        assert_eq!(shell(&policy, "echo \"`id`\""), Decision::Prompt);
        assert_eq!(shell(&policy, "cat a > b"), Decision::Prompt);
        assert_eq!(shell(&policy, "ls & rm -r x"), Decision::Prompt);
        assert_eq!(shell(&policy, "echo 'a; b | c'"), Decision::Allow);
    }

    #[test]
    fn saved_rules_round_trip() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = dir.path().join(POLICY_FILE);
        let mut policy = Policy::load(Some(path.clone()));
        policy.add_rule(Rule::new(&["npm", "install"], Decision::Allow, "trusted"));
        policy.save().unwrap_or_else(|err| panic!("{err}"));
        let reloaded = Policy::load(Some(path));
        assert_eq!(
            reloaded.evaluate(&argv("npm install vue"), false).decision,
            Decision::Allow
        );
        let mut reloaded = reloaded;
        assert!(!reloaded.remove_rule(&argv("ls")));
        assert!(reloaded.remove_rule(&argv("npm install")));
    }

    #[test]
    fn suggests_the_program_name() {
        assert_eq!(suggested_prefix(&argv("npm install x"), false), ["npm"]);
        assert_eq!(
            suggested_prefix(&["make test && ls".to_owned()], true),
            ["make"]
        );
        assert_eq!(blocked_pattern("sudo rm -rf /"), Some("rm -rf /"));
    }
}
