// The Command Center's business rules in one place: account states, block scopes, durations, reward types,
// report severities and statuses, ticket categories, and permissions. Views and action flows read these —
// nothing is hard-coded in the UI. (The server enforces the same rules; these are for explaining them.)

/** @typedef {'active'|'suspended'|'blocked'|'deactivated'} AccountStatus */

export const STATUS = {
    active: { label: 'Active', cls: 's-active', about: 'The account is operating normally.' },
    suspended: { label: 'Suspended', cls: 's-suspended', about: 'Temporarily restricted — can read, but can’t post, comment or message until the suspension ends.' },
    blocked: { label: 'Blocked', cls: 's-blocked', about: 'Kept out of specific parts of Cordial (see the scope).' },
    deactivated: { label: 'Deactivated', cls: 's-deactivated', about: 'Disabled — can’t sign in or use Cordial.' }
};
export const statusBadge = s => `<span class="badge ${(STATUS[s] || STATUS.active).cls}">${(STATUS[s] || STATUS.active).label}</span>`;

export const SCOPES = [
    ['platform', 'Platform-wide', 'Can’t post, comment, message, react or follow anywhere on Cordial'],
    ['messaging', 'Messaging', 'Can’t send direct or group messages'],
    ['comments', 'Comments', 'Can’t comment on posts or reels'],
    ['interactions', 'Interactions', 'Can’t like, react, repost or follow'],
    ['posting', 'Posting', 'Can’t publish posts, reels or stories']
];
export const scopeLabel = s => (SCOPES.find(x => x[0] === s) || [s, s])[1];

export const DURATIONS = [[24, '24 hours'], [72, '3 days'], [168, '7 days'], [720, '30 days'], [-1, 'Until lifted'], [0, 'Custom']];

export const REASONS = {
    suspend: ['Harassment or bullying', 'Spam', 'Hate speech', 'Scam or fraud', 'Sexual content', 'Impersonation', 'Repeated rule breaking'],
    block: ['Harassing people in messages', 'Spam comments', 'Abusive interactions', 'Repeated rule breaking'],
    deactivate: ['Severe or repeated violations', 'Fraud', 'Ban evasion', 'Owner’s request', 'Legal request'],
    reward: ['Community contribution', 'Helpful member', 'Bug report', 'Contest winner', 'Welcome gift', 'Apology for an issue']
};

export const REWARD = {
    xp: { label: 'XP', unit: 'XP', about: 'Adds to their level and the XP leaderboard', large: 5000 },
    coins: { label: 'Coins', unit: 'coins', about: 'Adds to their coin balance', large: 1000 },
    badge: { label: 'Badge', unit: '', about: 'Awards a badge to their profile' },
    special: { label: 'Special recognition', unit: '', about: 'A personal thank-you with your message, no balance change' }
};
export const isLargeReward = (kind, amount) => !!(REWARD[kind] && REWARD[kind].large && Number(amount) > REWARD[kind].large);

export const SEVERITY = ['critical', 'high', 'medium', 'low'];
export const sevBadge = s => `<span class="badge sev-${s || 'medium'}">${s ? s[0].toUpperCase() + s.slice(1) : 'Medium'}</span>`;
export const REPORT_STATUS = {
    open: 'Open', investigating: 'Investigating', actioned: 'Action taken', dismissed: 'Dismissed', appealed: 'Appealed', resolved: 'Resolved'
};
export const REPORT_REASON = {
    spam: 'Spam', harassment: 'Harassment', hate: 'Hate speech', violence: 'Violence or threats', sexual: 'Sexual content',
    self_harm: 'Self-harm', scam: 'Scam or fraud', impersonation: 'Impersonation', other: 'Other'
};
export const REPORT_KIND = { user: 'Account', dm: 'Direct message', gc: 'Group message', post: 'Group post', entry: 'Feed post', comment: 'Comment', listing: 'Listing' };
export const stBadge = (s, labels = {}) => `<span class="badge st-${s}">${labels[s] || (s ? s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '')}</span>`;

export const TICKET_CAT = {
    account: 'Account', recovery: 'Account recovery', rewards: 'Rewards', safety: 'Safety', bug: 'Bug', complaint: 'Complaint', other: 'Other'
};
export const PRIORITY = ['urgent', 'high', 'normal', 'low'];
export const prioBadge = p => `<span class="badge ${p === 'urgent' ? 'sev-critical' : p === 'high' ? 'sev-high' : p === 'low' ? 'sev-low' : 'sev-info'}">${p ? p[0].toUpperCase() + p.slice(1) : 'Normal'}</span>`;
export const TICKET_STATUS = { open: 'Open', pending: 'Waiting on user', escalated: 'Escalated', resolved: 'Resolved' };

export const ROLES = {
    super_admin: 'Super admin (everything)',
    moderator: 'Moderator (users, reports, audit)',
    support: 'Support (helpline, rewards)',
    analyst: 'Analyst (read-only analytics and audit)'
};

// What each audit action is called, and how it reads
export const ACTION_LABEL = {
    USER_SUSPENDED: 'Suspended', USER_BLOCKED: 'Blocked', USER_DEACTIVATED: 'Deactivated', USER_REACTIVATED: 'Restored',
    REWARD_SENT: 'Reward sent', REWARD_APPROVED: 'Reward approved', REWARD_DECLINED: 'Reward declined', REWARD_REVERSED: 'Reward reversed',
    REPORT_RESOLVED: 'Report resolved', REPORT_UPDATED: 'Report updated', SUPPORT_TICKET_UPDATED: 'Ticket updated', SUPPORT_REPLIED: 'Support replied',
    SUPPORT_NOTE_ADDED: 'Internal note', USER_MESSAGED: 'Messaged user', APPEAL_OVERTURNED: 'Appeal overturned', APPEAL_UPHELD: 'Appeal upheld',
    ADMIN_ROLE_CHANGED: 'Admin role changed', suspend: 'Suspended', suspension_lifted: 'Suspension lifted', badge_award: 'Badge awarded',
    badge_revoke: 'Badge removed', content_remove: 'Content removed', announce: 'Announcement', verify_approve: 'Verified', verify_reject: 'Verification declined'
};
export const actionLabel = a => ACTION_LABEL[a] || String(a || '').replace(/^report_/, 'Report: ').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());

// ---------- Permissions ----------
let perms = new Set();
/** @param {string[]} list */
export const setPerms = list => { perms = new Set(list || []); };
/** @param {string} p */
export const can = p => perms.has(p);
