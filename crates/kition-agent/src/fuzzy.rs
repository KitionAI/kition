//! Fuzzy path matching: the query's characters must appear in order;
//! consecutive runs, word starts, and filename hits score higher.

/// The match score, or `None` when `query` is not a subsequence.
pub fn score(query: &str, candidate: &str) -> Option<i64> {
    let query: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if query.is_empty() {
        return Some(0);
    }
    let chars: Vec<char> = candidate.chars().collect();
    let lower: Vec<char> = chars
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let filename_start = chars.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    let mut score = 0_i64;
    let mut next = 0;
    let mut previous: Option<usize> = None;
    for wanted in &query {
        let found = (next..lower.len()).find(|&i| lower[i] == *wanted)?;
        score += 10;
        if previous == Some(found.wrapping_sub(1)) {
            score += 15;
        }
        let boundary = found == 0
            || matches!(chars[found - 1], '/' | '_' | '-' | '.' | ' ')
            || (chars[found].is_uppercase() && chars[found - 1].is_lowercase());
        if boundary {
            score += 10;
        }
        if found >= filename_start {
            score += 5;
        }
        if let Some(previous) = previous {
            score -= (found - previous - 1).min(10) as i64;
        }
        previous = Some(found);
        next = found + 1;
    }
    Some(score - (chars.len() as i64 / 10))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_tight_filename_matches_first() {
        assert!(score("xyz", "src/main.rs").is_none());
        let exact = score("main", "src/main.rs").unwrap_or_default();
        let scattered = score("main", "src/my_animation.rs").unwrap_or_default();
        assert!(exact > scattered);
        let file = score("cfg", "crates/config.rs").unwrap_or_default();
        let dir = score("cfg", "config/global/x.rs").unwrap_or_default();
        assert!(file > dir);
    }
}
