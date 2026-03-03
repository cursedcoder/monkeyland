//! Project abstraction with state machine for git/beads lifecycle.
//!
//! Provides a unified interface for project operations with explicit state
//! transitions. Ensures worktrees can only be created when the project is ready.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Project lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectState {
    /// Directory exists but no git repository.
    Uninitialized,
    /// Git repo exists but has no commits (worktrees won't work).
    GitOnly,
    /// Has at least one commit; worktrees can be created.
    Ready,
    /// Beads initialized; full orchestration available.
    BeadsReady,
}

impl std::fmt::Display for ProjectState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectState::Uninitialized => write!(f, "Uninitialized"),
            ProjectState::GitOnly => write!(f, "GitOnly (no commits)"),
            ProjectState::Ready => write!(f, "Ready"),
            ProjectState::BeadsReady => write!(f, "BeadsReady"),
        }
    }
}

/// Errors that can occur during project operations.
#[derive(Debug, Clone)]
pub enum ProjectError {
    /// Directory doesn't exist or isn't a directory.
    InvalidPath(String),
    /// Operation requires a different state.
    InvalidState {
        current: ProjectState,
        required: ProjectState,
        operation: &'static str,
    },
    /// Git command failed.
    GitError(String),
    /// Beads command failed.
    BeadsError(String),
    /// Worktree operation failed.
    WorktreeError(String),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::InvalidPath(p) => write!(f, "Invalid project path: {p}"),
            ProjectError::InvalidState {
                current,
                required,
                operation,
            } => {
                write!(
                    f,
                    "Cannot {operation}: project is {current}, requires {required}"
                )
            }
            ProjectError::GitError(e) => write!(f, "Git error: {e}"),
            ProjectError::BeadsError(e) => write!(f, "Beads error: {e}"),
            ProjectError::WorktreeError(e) => write!(f, "Worktree error: {e}"),
        }
    }
}

impl std::error::Error for ProjectError {}

/// A project directory with tracked git/beads state.
///
/// Use `Project::open()` to load an existing project, then call state
/// transition methods like `ensure_ready()` before creating worktrees.
#[derive(Debug, Clone)]
pub struct Project {
    path: PathBuf,
    state: ProjectState,
}

impl Project {
    /// Open a project directory and detect its current state.
    pub fn open(path: &Path) -> Result<Self, ProjectError> {
        if !path.exists() {
            return Err(ProjectError::InvalidPath(format!(
                "Path does not exist: {}",
                path.display()
            )));
        }
        if !path.is_dir() {
            return Err(ProjectError::InvalidPath(format!(
                "Not a directory: {}",
                path.display()
            )));
        }

        let state = Self::detect_state(path);
        Ok(Self {
            path: path.to_path_buf(),
            state,
        })
    }

    /// Detect the current state of a project directory.
    fn detect_state(path: &Path) -> ProjectState {
        // Check for .beads directory (BeadsReady)
        if path.join(".beads").exists() {
            // Even with beads, we need commits for worktrees
            if Self::has_commits(path) {
                return ProjectState::BeadsReady;
            }
            // Beads exists but no commits - treat as GitOnly
            // (beads init should have created a commit, but handle edge case)
            if path.join(".git").exists() {
                return ProjectState::GitOnly;
            }
        }

        // Check for .git directory
        if path.join(".git").exists() {
            if Self::has_commits(path) {
                return ProjectState::Ready;
            }
            return ProjectState::GitOnly;
        }

        ProjectState::Uninitialized
    }

    /// Check if the repository has at least one commit.
    fn has_commits(path: &Path) -> bool {
        Command::new("git")
            .args(["rev-parse", "--verify", "--quiet", "HEAD"])
            .current_dir(path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Get the project path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Get the current project state.
    pub fn state(&self) -> ProjectState {
        self.state
    }

    /// Check if the project is ready for worktree operations.
    pub fn is_ready(&self) -> bool {
        matches!(self.state, ProjectState::Ready | ProjectState::BeadsReady)
    }

    /// Refresh the project state from disk.
    pub fn refresh(&mut self) {
        self.state = Self::detect_state(&self.path);
    }

    /// Ensure the project has a git repository.
    /// Transitions: Uninitialized -> GitOnly
    pub fn ensure_git(&mut self) -> Result<(), ProjectError> {
        if self.state != ProjectState::Uninitialized {
            return Ok(()); // Already has git
        }

        let out = Command::new("git")
            .arg("init")
            .current_dir(&self.path)
            .output()
            .map_err(|e| ProjectError::GitError(format!("Failed to run git init: {e}")))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(ProjectError::GitError(format!(
                "git init failed: {}",
                stderr.trim()
            )));
        }

        self.state = ProjectState::GitOnly;
        Ok(())
    }

    /// Ensure the project has at least one commit (required for worktrees).
    /// Transitions: Uninitialized -> Ready, GitOnly -> Ready
    pub fn ensure_ready(&mut self) -> Result<(), ProjectError> {
        // First ensure git exists
        self.ensure_git()?;

        if self.is_ready() {
            return Ok(()); // Already has commits
        }

        // Configure git identity if not set
        self.ensure_git_identity()?;

        // Create initial commit
        let out = Command::new("git")
            .args(["commit", "--allow-empty", "-m", "Initial commit"])
            .current_dir(&self.path)
            .output()
            .map_err(|e| ProjectError::GitError(format!("Failed to run git commit: {e}")))?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(ProjectError::GitError(format!(
                "Initial commit failed: {}",
                stderr.trim()
            )));
        }

        // Update state based on whether beads exists
        self.state = if self.path.join(".beads").exists() {
            ProjectState::BeadsReady
        } else {
            ProjectState::Ready
        };

        Ok(())
    }

    /// Ensure git user identity is configured (required for commits).
    fn ensure_git_identity(&self) -> Result<(), ProjectError> {
        // Check if email is set
        let email_out = Command::new("git")
            .args(["config", "user.email"])
            .current_dir(&self.path)
            .output()
            .map_err(|e| ProjectError::GitError(format!("git config: {e}")))?;

        if !email_out.status.success() || email_out.stdout.is_empty() {
            Command::new("git")
                .args(["config", "user.email", "monkeyland@local"])
                .current_dir(&self.path)
                .output()
                .map_err(|e| ProjectError::GitError(format!("git config user.email: {e}")))?;
        }

        // Check if name is set
        let name_out = Command::new("git")
            .args(["config", "user.name"])
            .current_dir(&self.path)
            .output()
            .map_err(|e| ProjectError::GitError(format!("git config: {e}")))?;

        if !name_out.status.success() || name_out.stdout.is_empty() {
            Command::new("git")
                .args(["config", "user.name", "Monkeyland"])
                .current_dir(&self.path)
                .output()
                .map_err(|e| ProjectError::GitError(format!("git config user.name: {e}")))?;
        }

        Ok(())
    }

    /// Initialize Beads in the project.
    /// Transitions: Ready -> BeadsReady
    pub fn ensure_beads(&mut self) -> Result<(), ProjectError> {
        // First ensure we have commits
        self.ensure_ready()?;

        if self.state == ProjectState::BeadsReady {
            return Ok(()); // Already initialized
        }

        let out = match Command::new("bd")
            .args(["init", "--quiet"])
            .current_dir(&self.path)
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Err(ProjectError::BeadsError(
                        "bd not found on PATH. Install with: npm i -g @anthropic-ai/beads"
                            .to_string(),
                    ));
                }
                return Err(ProjectError::BeadsError(format!("Failed to run bd: {e}")));
            }
        };

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // bd init may warn but still succeed
            if !self.path.join(".beads").exists() {
                return Err(ProjectError::BeadsError(format!(
                    "bd init failed: {}",
                    stderr.trim()
                )));
            }
        }

        self.state = ProjectState::BeadsReady;
        Ok(())
    }

    /// Create an isolated worktree for a developer agent.
    ///
    /// Requires: Ready or BeadsReady state
    /// Returns: Path to the worktree directory
    pub fn create_worktree(&self, agent_id: &str, task_id: &str) -> Result<PathBuf, ProjectError> {
        if !self.is_ready() {
            return Err(ProjectError::InvalidState {
                current: self.state,
                required: ProjectState::Ready,
                operation: "create worktree",
            });
        }

        crate::worktree::create(&self.path, agent_id, task_id).map_err(ProjectError::WorktreeError)
    }

    /// Remove a worktree for an agent.
    pub fn remove_worktree(&self, agent_id: &str) -> Result<(), ProjectError> {
        crate::worktree::remove(&self.path, agent_id).map_err(ProjectError::WorktreeError)
    }

    /// Merge a task branch back to the base branch.
    ///
    /// Requires: Ready or BeadsReady state
    pub fn merge_task(&self, task_id: &str) -> Result<crate::worktree::MergeOutcome, ProjectError> {
        if !self.is_ready() {
            return Err(ProjectError::InvalidState {
                current: self.state,
                required: ProjectState::Ready,
                operation: "merge task",
            });
        }

        crate::worktree::merge_to_base(&self.path, task_id).map_err(ProjectError::WorktreeError)
    }

    /// Delete a task branch after successful merge.
    pub fn delete_task_branch(&self, task_id: &str) -> Result<(), ProjectError> {
        crate::worktree::delete_task_branch(&self.path, task_id)
            .map_err(ProjectError::WorktreeError)
    }

    /// Get diff of a task branch against the base branch.
    pub fn diff_task(&self, task_id: &str) -> Result<String, ProjectError> {
        crate::worktree::diff_against_base(&self.path, task_id).map_err(ProjectError::WorktreeError)
    }

    /// Prune stale worktree entries.
    pub fn prune_worktrees(&self) -> Result<(), ProjectError> {
        crate::worktree::prune(&self.path).map_err(ProjectError::WorktreeError)
    }

    /// Remove all worktrees (used during reset).
    pub fn remove_all_worktrees(&self) -> Result<(), ProjectError> {
        crate::worktree::remove_all(&self.path).map_err(ProjectError::WorktreeError)
    }

    /// Detect the base branch name (main, master, or HEAD).
    pub fn base_branch(&self) -> String {
        crate::worktree::detect_base_branch(&self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_empty_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

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

    fn setup_git_no_commits() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        dir
    }

    #[test]
    fn test_open_nonexistent_path_fails() {
        let result = Project::open(Path::new("/nonexistent/path/12345"));
        assert!(matches!(result, Err(ProjectError::InvalidPath(_))));
    }

    #[test]
    fn test_open_file_fails() {
        let dir = setup_empty_dir();
        let file_path = dir.path().join("file.txt");
        fs::write(&file_path, "content").unwrap();

        let result = Project::open(&file_path);
        assert!(matches!(result, Err(ProjectError::InvalidPath(_))));
    }

    #[test]
    fn test_detect_state_uninitialized() {
        let dir = setup_empty_dir();
        let project = Project::open(dir.path()).unwrap();
        assert_eq!(project.state(), ProjectState::Uninitialized);
        assert!(!project.is_ready());
    }

    #[test]
    fn test_detect_state_git_only() {
        let dir = setup_git_no_commits();
        let project = Project::open(dir.path()).unwrap();
        assert_eq!(project.state(), ProjectState::GitOnly);
        assert!(!project.is_ready());
    }

    #[test]
    fn test_detect_state_ready() {
        let dir = setup_git_repo();
        let project = Project::open(dir.path()).unwrap();
        assert_eq!(project.state(), ProjectState::Ready);
        assert!(project.is_ready());
    }

    #[test]
    fn test_ensure_git_from_uninitialized() {
        let dir = setup_empty_dir();
        let mut project = Project::open(dir.path()).unwrap();
        assert_eq!(project.state(), ProjectState::Uninitialized);

        project.ensure_git().unwrap();

        assert_eq!(project.state(), ProjectState::GitOnly);
        assert!(dir.path().join(".git").exists());
    }

    #[test]
    fn test_ensure_ready_from_uninitialized() {
        let dir = setup_empty_dir();
        let mut project = Project::open(dir.path()).unwrap();

        project.ensure_ready().unwrap();

        assert_eq!(project.state(), ProjectState::Ready);
        assert!(project.is_ready());
    }

    #[test]
    fn test_ensure_ready_from_git_only() {
        let dir = setup_git_no_commits();
        let mut project = Project::open(dir.path()).unwrap();
        assert_eq!(project.state(), ProjectState::GitOnly);

        project.ensure_ready().unwrap();

        assert_eq!(project.state(), ProjectState::Ready);
        assert!(project.is_ready());
    }

    #[test]
    fn test_ensure_ready_idempotent() {
        let dir = setup_git_repo();
        let mut project = Project::open(dir.path()).unwrap();
        let initial_state = project.state();

        project.ensure_ready().unwrap();

        assert_eq!(project.state(), initial_state);
    }

    #[test]
    fn test_create_worktree_requires_ready() {
        let dir = setup_git_no_commits();
        let project = Project::open(dir.path()).unwrap();

        let result = project.create_worktree("agent-1", "task-1");

        assert!(matches!(
            result,
            Err(ProjectError::InvalidState {
                current: ProjectState::GitOnly,
                required: ProjectState::Ready,
                ..
            })
        ));
    }

    #[test]
    fn test_create_worktree_succeeds_when_ready() {
        let dir = setup_git_repo();
        let project = Project::open(dir.path()).unwrap();

        let wt_path = project.create_worktree("agent-1", "task-1").unwrap();

        assert!(wt_path.exists());
        assert!(wt_path.join(".git").exists());

        // Cleanup
        project.remove_worktree("agent-1").unwrap();
    }

    #[test]
    fn test_refresh_updates_state() {
        let dir = setup_empty_dir();
        let mut project = Project::open(dir.path()).unwrap();
        assert_eq!(project.state(), ProjectState::Uninitialized);

        // Manually init git
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        // State should still be Uninitialized (cached)
        assert_eq!(project.state(), ProjectState::Uninitialized);

        // After refresh, should detect GitOnly
        project.refresh();
        assert_eq!(project.state(), ProjectState::GitOnly);
    }

    #[test]
    fn test_project_error_display() {
        let err = ProjectError::InvalidState {
            current: ProjectState::GitOnly,
            required: ProjectState::Ready,
            operation: "create worktree",
        };
        let msg = format!("{err}");
        assert!(msg.contains("create worktree"));
        assert!(msg.contains("GitOnly"));
        assert!(msg.contains("Ready"));
    }
}
