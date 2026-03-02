//! Git worktree management for developer agent isolation.
//!
//! Each developer agent gets its own worktree under `.worktrees/<agent_id>/`
//! on a dedicated branch `task/<task_id>`. All functions are synchronous
//! (callers use `spawn_blocking`).

use std::path::{Path, PathBuf};
use std::process::Command;

/// Outcome of merging a worktree branch back to the base branch.
#[derive(Debug, Clone)]
pub enum MergeOutcome {
    Clean,
    Conflict(String),
}

/// Returns the path where a worktree would live: `<project>/.worktrees/<agent_id>`.
pub fn worktree_path_for(project_path: &Path, agent_id: &str) -> PathBuf {
    project_path.join(".worktrees").join(agent_id)
}

/// Detect the default branch name (`main`, `master`, or fall back to `HEAD`).
pub fn detect_base_branch(project_path: &Path) -> String {
    let out = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", "refs/heads/main"])
        .current_dir(project_path)
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            return "main".to_string();
        }
    }
    let out = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", "refs/heads/master"])
        .current_dir(project_path)
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            return "master".to_string();
        }
    }
    "HEAD".to_string()
}

/// Ensure `.worktrees/` is listed in `.gitignore`. Idempotent.
pub fn ensure_gitignore_entry(project_path: &Path) -> Result<(), String> {
    let gitignore = project_path.join(".gitignore");
    let entry = ".worktrees/";

    if gitignore.exists() {
        let content =
            std::fs::read_to_string(&gitignore).map_err(|e| format!("read .gitignore: {e}"))?;
        if content.lines().any(|line| line.trim() == entry) {
            return Ok(());
        }
        let separator = if content.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&gitignore, format!("{content}{separator}{entry}\n"))
            .map_err(|e| format!("write .gitignore: {e}"))?;
    } else {
        std::fs::write(&gitignore, format!("{entry}\n"))
            .map_err(|e| format!("create .gitignore: {e}"))?;
    }
    Ok(())
}

/// Check whether a local branch exists.
fn branch_exists(project_path: &Path, branch: &str) -> bool {
    Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .current_dir(project_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create an isolated worktree for a developer agent.
///
/// - Directory: `.worktrees/<agent_id>`
/// - Branch: `task/<task_id>` (created from base if new, reused if exists)
///
/// Returns the absolute path to the worktree directory.
pub fn create(project_path: &Path, agent_id: &str, task_id: &str) -> Result<PathBuf, String> {
    ensure_gitignore_entry(project_path)?;

    let wt_dir = worktree_path_for(project_path, agent_id);
    let branch_name = format!("task/{task_id}");

    std::fs::create_dir_all(project_path.join(".worktrees"))
        .map_err(|e| format!("mkdir .worktrees: {e}"))?;

    let out = if branch_exists(project_path, &branch_name) {
        Command::new("git")
            .args(["worktree", "add", wt_dir.to_str().unwrap(), &branch_name])
            .current_dir(project_path)
            .output()
            .map_err(|e| format!("git worktree add (existing branch): {e}"))?
    } else {
        Command::new("git")
            .args([
                "worktree",
                "add",
                wt_dir.to_str().unwrap(),
                "-b",
                &branch_name,
            ])
            .current_dir(project_path)
            .output()
            .map_err(|e| format!("git worktree add: {e}"))?
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git worktree add failed: {}", stderr.trim()));
    }

    Ok(wt_dir)
}

/// Remove a worktree and prune stale entries. No-op if it doesn't exist.
pub fn remove(project_path: &Path, agent_id: &str) -> Result<(), String> {
    let wt_dir = worktree_path_for(project_path, agent_id);
    if !wt_dir.exists() {
        // Already gone — prune just in case and return Ok
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(project_path)
            .output();
        return Ok(());
    }

    let out = Command::new("git")
        .args(["worktree", "remove", "--force", wt_dir.to_str().unwrap()])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // If directory was already removed externally, just prune
        if !stderr.contains("is not a working tree") {
            return Err(format!("git worktree remove failed: {}", stderr.trim()));
        }
    }

    let _ = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(project_path)
        .output();

    Ok(())
}

/// Rebase the task branch onto the current base branch.
///
/// Returns `Ok(true)` if rebase succeeded (no conflicts), `Ok(false)` if conflicts
/// were detected (rebase is aborted automatically). Must be called when no worktree
/// is checked out on the task branch.
pub fn rebase_onto_base(project_path: &Path, task_id: &str) -> Result<bool, String> {
    let branch_name = format!("task/{task_id}");
    let base = detect_base_branch(project_path);

    let out = Command::new("git")
        .args(["rebase", &base, &branch_name])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git rebase: {e}"))?;

    if out.status.success() {
        // Switch back to base branch after rebase
        let _ = Command::new("git")
            .args(["checkout", &base])
            .current_dir(project_path)
            .output();
        return Ok(true);
    }

    // Rebase failed (conflicts) -- abort to leave repo clean
    let _ = Command::new("git")
        .args(["rebase", "--abort"])
        .current_dir(project_path)
        .output();

    // `git rebase <base> <branch>` checks out <branch> first; after abort HEAD
    // is still on the task branch. Switch back to base so subsequent git
    // operations (merge, worktree add) run against the correct branch.
    let _ = Command::new("git")
        .args(["checkout", &base])
        .current_dir(project_path)
        .output();

    Ok(false)
}

/// Delete a task branch after successful merge.
pub fn delete_task_branch(project_path: &Path, task_id: &str) -> Result<(), String> {
    let branch_name = format!("task/{task_id}");
    let _ = Command::new("git")
        .args(["branch", "-d", &branch_name])
        .current_dir(project_path)
        .output();
    Ok(())
}

/// Get the list of conflicted files from a failed merge or rebase attempt.
/// Used to provide context to the merge agent.
pub fn conflict_diff(project_path: &Path, task_id: &str) -> Result<String, String> {
    let branch_name = format!("task/{task_id}");
    let base = detect_base_branch(project_path);

    // Show what files differ between base and the task branch
    let out = Command::new("git")
        .args(["diff", &base, &branch_name, "--stat"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git diff --stat: {e}"))?;

    let stat = String::from_utf8_lossy(&out.stdout).to_string();

    // Also get the full diff for context
    let out2 = Command::new("git")
        .args(["diff", &base, &branch_name])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git diff: {e}"))?;

    let full = String::from_utf8_lossy(&out2.stdout).to_string();
    // Truncate to avoid massive payloads
    let truncated = if full.len() > 8000 {
        format!(
            "{}...\n[truncated, {} bytes total]",
            &full[..8000],
            full.len()
        )
    } else {
        full
    };

    Ok(format!("Changed files:\n{stat}\nFull diff:\n{truncated}"))
}

/// Merge the agent's task branch into the base branch (non-fast-forward).
///
/// Must be called from the main repo directory (not from inside a worktree).
/// Returns `Clean` on success or `Conflict` with details if files collide.
pub fn merge_to_base(project_path: &Path, task_id: &str) -> Result<MergeOutcome, String> {
    let branch_name = format!("task/{task_id}");
    let base = detect_base_branch(project_path);

    // Ensure we're on the base branch
    let checkout = Command::new("git")
        .args(["checkout", &base])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git checkout base: {e}"))?;
    if !checkout.status.success() {
        let stderr = String::from_utf8_lossy(&checkout.stderr);
        return Err(format!("checkout {base} failed: {}", stderr.trim()));
    }

    let merge = Command::new("git")
        .args([
            "merge",
            "--no-ff",
            &branch_name,
            "-m",
            &format!("Merge {branch_name}"),
        ])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git merge: {e}"))?;

    if merge.status.success() {
        return Ok(MergeOutcome::Clean);
    }

    let stderr = String::from_utf8_lossy(&merge.stderr).to_string();
    let stdout = String::from_utf8_lossy(&merge.stdout).to_string();

    // Abort the failed merge to leave base branch clean
    let _ = Command::new("git")
        .args(["merge", "--abort"])
        .current_dir(project_path)
        .output();

    Ok(MergeOutcome::Conflict(format!("{stdout}\n{stderr}")))
}

/// Get a diff of only this task branch's changes against the base branch.
pub fn diff_against_base(project_path: &Path, task_id: &str) -> Result<String, String> {
    let branch_name = format!("task/{task_id}");
    let base = detect_base_branch(project_path);

    let out = Command::new("git")
        .args(["diff", &format!("{base}...{branch_name}")])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git diff: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git diff failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Remove all worktrees under `.worktrees/` and prune. Used by `full_reset`.
pub fn remove_all(project_path: &Path) -> Result<(), String> {
    let wt_root = project_path.join(".worktrees");
    if !wt_root.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(&wt_root).map_err(|e| format!("read .worktrees: {e}"))?;
    for entry in entries.flatten() {
        if entry.file_type().map_or(false, |ft| ft.is_dir()) {
            let agent_id = entry.file_name().to_string_lossy().to_string();
            let _ = remove(project_path, &agent_id);
        }
    }

    let _ = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(project_path)
        .output();

    Ok(())
}

/// Prune stale worktree entries (dangling references from crashed agents).
pub fn prune(project_path: &Path) -> Result<(), String> {
    let out = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(project_path)
        .output()
        .map_err(|e| format!("git worktree prune: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git worktree prune failed: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        dir
    }

    fn setup_git_repo_master() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "-b", "master"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        dir
    }

    #[test]
    fn test_worktree_path_for() {
        let p = Path::new("/tmp/myproject");
        assert_eq!(
            worktree_path_for(p, "agent-123"),
            PathBuf::from("/tmp/myproject/.worktrees/agent-123")
        );
    }

    #[test]
    fn test_detect_base_branch_main() {
        let dir = setup_git_repo();
        assert_eq!(detect_base_branch(dir.path()), "main");
    }

    #[test]
    fn test_detect_base_branch_master_fallback() {
        let dir = setup_git_repo_master();
        assert_eq!(detect_base_branch(dir.path()), "master");
    }

    #[test]
    fn test_create_worktree_success() {
        let dir = setup_git_repo();
        let wt = create(dir.path(), "agent-1", "bd-42").unwrap();

        assert!(wt.exists(), "worktree directory should exist");
        assert!(
            wt.join(".git").exists(),
            "worktree should be a git checkout"
        );

        // Branch should exist
        assert!(branch_exists(dir.path(), "task/bd-42"));

        // Worktree shows up in git worktree list
        let list = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&list.stdout);
        assert!(stdout.contains("agent-1"), "worktree should appear in list");

        // .gitignore should contain .worktrees/ (ensure_gitignore_entry ran)
        let gitignore = dir.path().join(".gitignore");
        assert!(gitignore.exists(), ".gitignore should exist after create");
        let gi_content = fs::read_to_string(&gitignore).unwrap();
        assert!(
            gi_content.contains(".worktrees/"),
            ".gitignore should contain .worktrees/ entry"
        );

        // Worktree should be on the task branch
        let branch = Command::new("git")
            .args(["symbolic-ref", "--short", "HEAD"])
            .current_dir(&wt)
            .output()
            .unwrap();
        let branch_str = String::from_utf8_lossy(&branch.stdout).trim().to_string();
        assert_eq!(
            branch_str, "task/bd-42",
            "worktree should be checked out on the task branch"
        );
    }

    #[test]
    fn test_create_worktree_existing_branch() {
        let dir = setup_git_repo();

        // Create a branch manually
        Command::new("git")
            .args(["branch", "task/bd-99"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        // create() should reuse the existing branch
        let wt = create(dir.path(), "agent-2", "bd-99").unwrap();
        assert!(wt.exists());
        assert!(branch_exists(dir.path(), "task/bd-99"));
    }

    #[test]
    fn test_remove_worktree_success() {
        let dir = setup_git_repo();
        let wt = create(dir.path(), "agent-3", "bd-50").unwrap();
        assert!(wt.exists());

        remove(dir.path(), "agent-3").unwrap();
        assert!(!wt.exists(), "worktree directory should be gone");

        let list = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&list.stdout);
        assert!(
            !stdout.contains("agent-3"),
            "worktree should not appear in list"
        );
    }

    #[test]
    fn test_remove_worktree_missing_is_ok() {
        let dir = setup_git_repo();
        // Removing a non-existent worktree should succeed
        let result = remove(dir.path(), "nonexistent-agent");
        assert!(result.is_ok());
    }

    #[test]
    fn test_merge_to_base_clean() {
        let dir = setup_git_repo();
        let wt = create(dir.path(), "agent-4", "bd-60").unwrap();

        // Make a commit in the worktree
        fs::write(wt.join("hello.txt"), "hello world").unwrap();
        Command::new("git")
            .args(["add", "hello.txt"])
            .current_dir(&wt)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "add hello"])
            .current_dir(&wt)
            .output()
            .unwrap();

        // Remove worktree first (can't merge while checked out in worktree)
        remove(dir.path(), "agent-4").unwrap();

        // Merge
        let outcome = merge_to_base(dir.path(), "bd-60").unwrap();
        assert!(
            matches!(outcome, MergeOutcome::Clean),
            "merge should be clean"
        );

        // The file should now exist on the base branch with correct content
        let content = fs::read_to_string(dir.path().join("hello.txt")).unwrap();
        assert_eq!(content, "hello world", "merged file content should match");

        // HEAD should be on main (not detached or stuck on task branch)
        let head = Command::new("git")
            .args(["symbolic-ref", "--short", "HEAD"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();
        assert_eq!(head_str, "main", "HEAD should be on main after merge");

        // No stale merge state
        assert!(
            !dir.path().join(".git/MERGE_HEAD").exists(),
            "no MERGE_HEAD should remain after clean merge"
        );
    }

    #[test]
    fn test_merge_to_base_conflict() {
        let dir = setup_git_repo();

        // Create a file on base
        fs::write(dir.path().join("conflict.txt"), "base content").unwrap();
        Command::new("git")
            .args(["add", "conflict.txt"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "base file"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        let wt = create(dir.path(), "agent-5", "bd-70").unwrap();

        // Modify the same file differently in the worktree
        fs::write(wt.join("conflict.txt"), "worktree content").unwrap();
        Command::new("git")
            .args(["add", "conflict.txt"])
            .current_dir(&wt)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "worktree change"])
            .current_dir(&wt)
            .output()
            .unwrap();

        // Also modify it on base (to create a real conflict)
        remove(dir.path(), "agent-5").unwrap();
        fs::write(dir.path().join("conflict.txt"), "different base content").unwrap();
        Command::new("git")
            .args(["add", "conflict.txt"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "base conflicting change"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        let outcome = merge_to_base(dir.path(), "bd-70").unwrap();
        assert!(
            matches!(outcome, MergeOutcome::Conflict(_)),
            "merge should detect conflict"
        );

        // Base branch should be clean (merge aborted)
        let content = fs::read_to_string(dir.path().join("conflict.txt")).unwrap();
        assert_eq!(content, "different base content");
    }

    #[test]
    fn test_diff_against_base() {
        let dir = setup_git_repo();
        let wt = create(dir.path(), "agent-6", "bd-80").unwrap();

        // Commit a new file in the worktree
        fs::write(wt.join("new_file.rs"), "fn main() {}").unwrap();
        Command::new("git")
            .args(["add", "new_file.rs"])
            .current_dir(&wt)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "add new_file"])
            .current_dir(&wt)
            .output()
            .unwrap();

        let diff = diff_against_base(dir.path(), "bd-80").unwrap();
        assert!(diff.contains("new_file.rs"), "diff should mention new file");
        assert!(
            diff.contains("fn main()"),
            "diff should contain file content"
        );
    }

    #[test]
    fn test_ensure_gitignore_entry() {
        let dir = setup_git_repo();

        // First call creates .gitignore with entry
        ensure_gitignore_entry(dir.path()).unwrap();
        let content = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(content.contains(".worktrees/"));

        // Second call is idempotent
        ensure_gitignore_entry(dir.path()).unwrap();
        let content2 = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        let count = content2.matches(".worktrees/").count();
        assert_eq!(count, 1, ".worktrees/ should appear exactly once");
    }

    #[test]
    fn test_remove_all() {
        let dir = setup_git_repo();
        let wt1 = create(dir.path(), "agent-a", "bd-1").unwrap();
        let wt2 = create(dir.path(), "agent-b", "bd-2").unwrap();
        assert!(wt1.exists());
        assert!(wt2.exists());

        remove_all(dir.path()).unwrap();

        assert!(!wt1.exists(), "first worktree should be removed");
        assert!(!wt2.exists(), "second worktree should be removed");

        // git worktree list should only contain the main worktree
        let list = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&list.stdout).to_string();
        assert!(
            !stdout.contains("agent-a"),
            "agent-a should not appear in worktree list after remove_all"
        );
        assert!(
            !stdout.contains("agent-b"),
            "agent-b should not appear in worktree list after remove_all"
        );
    }
}
