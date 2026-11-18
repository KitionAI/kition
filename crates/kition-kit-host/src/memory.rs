// Copied from kition-sdk crates/kition-kit-host/src/memory.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Safe resident-size monitoring; the host does the sampling outside the kit sandbox.

use std::io;

pub fn check(bytes: u64) -> Result<(), String> {
    if bytes == 0 {
        return Err("the kit memory limit must be positive".into());
    }
    if (cfg!(target_os = "linux") && std::fs::read_to_string("/proc/self/status").is_ok())
        || (cfg!(target_os = "macos") && std::path::Path::new("/bin/ps").is_file())
    {
        Ok(())
    } else {
        Err(format!("a safe kit resident-size reader is unavailable on {}; memory limits are refused", std::env::consts::OS))
    }
}

pub(crate) fn exceeded(resident: u64, ceiling: u64) -> bool {
    resident > ceiling
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn kib(text: &str) -> io::Result<u64> {
    text.trim().parse::<u64>().ok().and_then(|value| value.checked_mul(1024)).ok_or_else(|| io::Error::other("invalid resident size"))
}

#[cfg(target_os = "linux")]
pub(crate) async fn resident(pid: u32) -> io::Result<Option<u64>> {
    let text = match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    match text.lines().find_map(|line| line.strip_prefix("VmRSS:")) {
        Some(value) => kib(value.trim().strip_suffix("kB").ok_or_else(|| io::Error::other("invalid VmRSS units"))?).map(Some),
        // Exited processes have no resident set.
        None => Ok(None),
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn resident(pid: u32) -> io::Result<Option<u64>> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tokio::process::Command::new("/bin/ps").args(["-o", "rss=", "-p", &pid.to_string()]).kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| io::Error::other("resident-size sampling timed out"))??;
    let text = String::from_utf8(output.stdout).map_err(io::Error::other)?;
    if output.status.success() {
        kib(&text).map(Some)
    } else if text.trim().is_empty() {
        Ok(None)
    } else {
        Err(io::Error::other("could not sample the kit's resident size"))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) async fn resident(_pid: u32) -> io::Result<Option<u64>> {
    Err(io::Error::other("resident-size monitoring is unsupported"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_policy_is_exact_and_never_silently_unsupported() {
        assert!(!exceeded(1024, 1024));
        assert!(exceeded(1025, 1024));
        assert_eq!(kib(" 123 ").unwrap(), 123 * 1024);
        assert!(kib("18446744073709551615").is_err());
        assert!(check(0).is_err());
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(check(1024).unwrap_err().contains("refused"));
        }
    }
}
