//! RFC 5322 single-address parsing (`Name <local@domain>` or a bare
//! address), returning the address part.

struct Cursor<'a> {
    s: &'a [char],
    pos: usize,
}

fn is_atext(c: char, dot: bool) -> bool {
    c.is_ascii_alphanumeric()
        || "!#$%&'*+-/=?^_`{|}~".contains(c)
        || (dot && c == '.')
        || !c.is_ascii()
}

impl Cursor<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.pos).copied()
    }

    fn done(&self) -> bool {
        self.pos >= self.s.len()
    }

    /// Skips whitespace and nested `(comments)`.
    fn skip_cfws(&mut self) -> Result<(), String> {
        loop {
            while self
                .peek()
                .is_some_and(|c| c == ' ' || c == '\t' || c == '\r' || c == '\n')
            {
                self.pos += 1;
            }
            if self.peek() != Some('(') {
                return Ok(());
            }
            let mut depth = 0;
            loop {
                match self.peek() {
                    None => return Err("mail: misformatted parenthetical comment".into()),
                    Some('\\') => self.pos += 2,
                    Some('(') => {
                        depth += 1;
                        self.pos += 1;
                    }
                    Some(')') => {
                        depth -= 1;
                        self.pos += 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    Some(_) => self.pos += 1,
                }
            }
        }
    }

    fn atom(&mut self, dot: bool) -> Result<String, String> {
        let start = self.pos;
        while self.peek().is_some_and(|c| is_atext(c, dot)) {
            self.pos += 1;
        }
        if self.pos == start {
            return Err("mail: invalid string".into());
        }
        let text: String = self.s[start..self.pos].iter().collect();
        if dot && (text.starts_with('.') || text.ends_with('.') || text.contains("..")) {
            return Err(if text.contains("..") {
                "mail: double dot in atom"
            } else {
                "mail: leading or trailing dot in atom"
            }
            .into());
        }
        Ok(text)
    }

    fn quoted(&mut self) -> Result<String, String> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err("mail: unclosed quoted-string".into()),
                Some('"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some('\\') => {
                    self.pos += 1;
                    match self.peek() {
                        Some(c) => out.push(c),
                        None => return Err("mail: unclosed quoted-string".into()),
                    }
                    self.pos += 1;
                }
                Some(c) => {
                    out.push(c);
                    self.pos += 1;
                }
            }
        }
    }

    fn addr_spec(&mut self) -> Result<String, String> {
        let start = self.pos;
        let local = if self.peek() == Some('"') {
            let text = self.quoted()?;
            if text.is_empty() {
                return Err("mail: empty quoted-string in addr-spec".into());
            }
            text
        } else {
            self.atom(true)?
        };
        if self.peek() != Some('@') {
            self.pos = start;
            return Err("mail: missing @ in addr-spec".into());
        }
        self.pos += 1;
        let domain = if self.peek() == Some('[') {
            let open = self.pos;
            while self.peek().is_some_and(|c| c != ']') {
                self.pos += 1;
            }
            if self.done() {
                return Err("mail: unclosed domain-literal".into());
            }
            self.pos += 1;
            self.s[open..self.pos].iter().collect()
        } else {
            self.atom(true)
                .map_err(|_| "mail: invalid domain in addr-spec".to_owned())?
        };
        Ok(format!("{local}@{domain}"))
    }
}

/// Parses one address and returns `local@domain`.
pub fn parse_address(input: &str) -> Result<String, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut cursor = Cursor { s: &chars, pos: 0 };
    cursor.skip_cfws()?;
    if cursor.done() {
        return Err("mail: no address".into());
    }
    let start = cursor.pos;
    if let Ok(address) = cursor.addr_spec() {
        cursor.skip_cfws()?;
        if cursor.done() {
            return Ok(address);
        }
        return Err("mail: expected single address".into());
    }
    cursor.pos = start;
    // Display name: a phrase of atoms and quoted strings.
    if cursor.peek() != Some('<') {
        let mut words = 0;
        loop {
            cursor.skip_cfws()?;
            match cursor.peek() {
                Some('"') => {
                    cursor.quoted()?;
                }
                Some('<') | None => break,
                Some(_) => {
                    cursor
                        .atom(true)
                        .map_err(|_| "mail: missing word in phrase".to_owned())?;
                }
            }
            words += 1;
        }
        if words == 0 {
            return Err("mail: missing word in phrase".into());
        }
    }
    cursor.skip_cfws()?;
    if cursor.peek() != Some('<') {
        return Err("mail: no angle-addr".into());
    }
    cursor.pos += 1;
    let address = cursor.addr_spec()?;
    if cursor.peek() != Some('>') {
        return Err("mail: unclosed angle-addr".into());
    }
    cursor.pos += 1;
    cursor.skip_cfws()?;
    if !cursor.done() {
        return Err("mail: expected single address".into());
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::parse_address;

    #[test]
    fn parses_addresses() {
        assert_eq!(parse_address("a@b.co"), Ok("a@b.co".into()));
        assert_eq!(
            parse_address(" Ada Lovelace <ada@example.com> "),
            Ok("ada@example.com".into())
        );
        assert_eq!(
            parse_address("\"Ada, L\" <ada@example.com>"),
            Ok("ada@example.com".into())
        );
        assert_eq!(
            parse_address("\"a b\"@example.com"),
            Ok("a b@example.com".into())
        );
        assert_eq!(parse_address("a@[127.0.0.1]"), Ok("a@[127.0.0.1]".into()));
        assert_eq!(parse_address("a@b.co (work)"), Ok("a@b.co".into()));
        for bad in [
            "",
            "plain",
            "a@",
            "@b.co",
            "a..b@c.d",
            "a@b.co c@d.e",
            "Ada <ada@x",
            "a b@c.d",
            "<>",
        ] {
            assert!(parse_address(bad).is_err(), "{bad}");
        }
    }
}
