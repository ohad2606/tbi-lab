/**
 * TBI Lab Admin's own English texts. The administration's shared texts (admin.*, the report kinds
 * and areas) come from @tbi-lab/admin-client, the same as the Lab's; these are the app's screens.
 */
export const consoleEn = {
  'console.appName': 'TBI Lab Admin',
  'console.skip': 'Skip to content',
  'console.nav.label': 'Sections',
  'console.nav.today': 'Today',
  'console.nav.testers': 'Testers',
  'console.nav.add': 'Add tester',
  'console.nav.feedback': 'Feedback',
  'console.nav.activity': 'Activity log',
  'console.nav.settings': 'Settings',
  'console.nav.more': 'More',
  'console.refresh': 'Refresh',
  'console.back': 'Back',

  'console.access.signedOut.title': 'You are signed out',
  'console.access.signedOut.text': 'Your sign-in has expired or you are not signed in.',
  'console.access.signIn': 'Sign in again',
  'console.access.forbidden.title': 'No access',
  'console.access.forbidden.text':
    'This Google account cannot use TBI Lab Admin. Sign out to use another account.',
  'console.access.signOut': 'Sign out',

  'console.today.heading': 'Today',
  'console.today.capacity': 'Live simulations now',
  'console.today.testers': 'Tester places',
  'console.today.active': 'Active testers today',
  'console.today.usageHeading': 'Activity today',
  'console.today.unmatched': 'Includes activity of accounts that are not in the list.',
  'console.today.updated': 'Usage counted up to {time}.',
  'console.today.feedback': 'Feedback',
  'console.today.unread': '{unread} new of {total}',
  'console.today.changes': 'Last changes',
  'console.today.allChanges': 'Open the activity log',

  'console.metric.signIns': 'Sign-ins',
  'console.metric.builds': 'Builds',
  'console.metric.prebuilt': 'Prebuilt uploads',
  'console.metric.runs': 'Runs',
  'console.metric.simSeconds': 'Simulation minutes',
  'console.metric.refusals': 'Refusals',

  'console.usage.unavailable': 'The usage history is not available right now.',
  'console.audit.unavailable': 'The activity log is not available right now.',
  'console.capacity.unavailable': 'Not available right now.',
  'console.accounts.unavailable': 'The tester list is not available right now.',
  'console.reports.unavailable': 'Feedback is not available right now.',

  'console.testers.heading': 'Testers',
  'console.testers.search': 'Search by name or masked address',
  'console.testers.sorted': 'Most recent activity first.',
  'console.testers.none': 'No testers match.',
  'console.testers.lastActivity': 'Last activity',
  'console.testers.noActivity': 'No activity yet',
  'console.testers.open': 'Details',
  'console.testers.open.label': 'Details for {account}',

  'console.tester.title': 'Tester',
  'console.tester.notFound': 'This tester is not in the list.',
  'console.tester.usage': 'Last 30 days',
  'console.tester.chart.label': '{metric} per day, last 30 days: {total} in total',
  'console.tester.chart.metric': 'Chart',
  'console.tester.lastSeen': 'Last seen',
  'console.tester.details': 'Account',
  'console.tester.checking': 'Checking automatically…',

  'console.unknownAccount': 'Unknown account',

  'console.add.heading': 'Add tester',
  'console.add.open': 'Open the tester',

  'console.feedback.heading': 'Feedback',
  'console.report.title': 'Report',
  'console.feedback.new': 'New',
  'console.feedback.newNote': 'New: not opened yet on this device.',
  'console.feedback.kind.other': 'Other feedback',
  'console.feedback.category.other': 'Other area',

  'console.activity.heading': 'Activity log',
  'console.activity.when': 'Time',
  'console.activity.action': 'Change',
  'console.activity.account': 'Account',
  'console.activity.result': 'Result',
  'console.activity.empty': 'No changes recorded yet.',
  'console.activity.count': '({count})',
  'console.audit.action.add': 'Tester added',
  'console.audit.action.disable': 'Tester disabled',
  'console.audit.action.reactivate': 'Tester reactivated',
  'console.audit.action.rename': 'Renamed',
  'console.audit.action.refused': 'Request refused',
  'console.audit.action.record_identity': 'Google account recorded',
  'console.audit.action.identity_mismatch': 'Different Google account',
  'console.audit.action.unknown_identity': 'Sign-in by an unknown account',
  'console.audit.action.sign_ins': 'Sign-ins recorded',
  'console.audit.action.prune_backups': 'Old backups removed',

  'console.audit.action.other': 'Other change',
  'console.result.done': 'Done',
  'console.result.ok': 'Completed',
  'console.result.forbidden': 'Not permitted',
  'console.result.invalid': 'Invalid request',
  'console.result.rate_limited': 'Too many requests',
  'console.result.cap_reached': 'All places taken',
  'console.result.exists': 'Already exists',
  'console.result.unknown_target': 'Account not found',
  'console.result.last_owner': 'Owner kept',
  'console.result.conflict': 'Changed meanwhile',
  'console.result.error': 'Failed',
  'console.result.unparseable': 'Unreadable',
  'console.result.held': 'Kept',
  'console.result.other': 'Other result',

  'console.settings.heading': 'Settings',
  'console.settings.language': 'Language',
  'console.settings.signOut': 'Sign out',
  'console.settings.signOutHint': 'Ends your TBI Lab Admin sign-in in this browser.',
  'console.nav.signups': 'Sign-up requests',
  'console.signups.heading': 'Open sign-up requests',
  'console.signups.intro':
    'People who asked to join, and approved requests whose email has not gone out yet. Approve adds the account and sends the welcome email.',
  'console.signups.count.one': '1 request waiting for you',
  'console.signups.count.other': '{count} requests waiting for you',
  'console.signups.count.queuedOnly': 'No requests need your action. Scheduled emails: {count}',
  'console.signups.count.held': 'Held emails: {count}',
  'console.signups.count.noAction': 'No requests need your action',
  'console.signups.count.auto.one': '1 request is waiting for automatic approval',
  'console.signups.count.auto.other': '{count} requests are waiting for automatic approval',
  'console.signups.empty': 'No open sign-up requests.',
  'console.signups.unavailable': 'Sign-up requests are not available right now.',
  'console.signups.refresh': 'Refresh requests',
  'console.signups.requested': 'Requested {time}',
  'console.signups.role': 'Role',
  'console.signups.language': 'Language',
  'console.signups.lang.he': 'Hebrew',
  'console.signups.lang.en': 'English',
  'console.signups.lang.other': 'Other',
  'console.signups.status.accountUnconfirmed': 'Account not confirmed',
  'console.signups.status.pending': 'Waiting for your decision',
  'console.signups.status.autoWait': 'Waiting for automatic approval',
  'console.signups.status.emailFailed': 'Account added, but the email was not sent. Use Resend.',
  'console.signups.status.emailFailed.addrChanged':
    'Account added, but no email was sent: the address on the request is not the one the account was added for. Resend will not help. Check the tester in Testers; if the request is wrong, delete it under "Stored requests and deletion".',
  'console.signups.status.emailFailed.unbound':
    'Account added, but the email was held: we have no record of the account for this address. Use Resend email: it checks the account and records it. If it fails again, check the server log.',
  'console.signups.status.emailFailed.unproven':
    'The automatic approval email was held: the address confirmation was not found. If you approve this person, use Resend email; it sends the email on your approval.',
  'console.signups.status.emailFailed.stateUnsafe':
    'Account added, but the email was held: the sign-up state folder on the server is unsafe. Resend will fail until it is fixed. Check the server log, fix the folder, then use Resend email.',
  'console.signups.status.emailFailed.config':
    'Account added, but the email was not sent: the email service is not set up correctly on the server (its key is missing or cannot be used). Resend will fail until it is fixed. Check the server log, then use Resend email.',
  'console.signups.status.emailFailed.refused':
    'Account added, but the mail service refused the request. Check the mail settings and the server log, then use Resend email.',
  'console.signups.status.emailFailed.temporary':
    'Account added, but sending the email was not confirmed: the mail service may be temporarily unavailable. Try again later with Resend email.',
  'console.signups.status.accountPending':
    'Approved, but the account is not ready yet. Approve again to finish.',
  'console.signups.status.emailQueued':
    'Account added. The email is queued and has not been sent yet.',
  'console.signups.status.emailHeld':
    'Account added. The email is held and has not been sent: automatic approval is paused, or its pause state could not be checked safely.',
  'console.signups.status.emailMailCap':
    'Account added. The email is waiting because of the email limit; it is normally sent automatically later.',
  'console.signups.heardFrom': 'How they heard about us',
  'console.signups.origin.web': 'Web form',
  'console.signups.autoApproved': 'Approved automatically',
  'console.signups.auto.heading': 'Auto-approve status',
  'console.signups.auto.off': 'Auto-approve is off.',
  'console.signups.auto.unknown': 'Auto-approve status is unknown.',
  'console.signups.auto.checking': 'Checking the auto-approve status…',
  'console.signups.auto.checked': 'Auto-approve status check finished.',
  'console.signups.auto.unavailable': 'Auto-approve status is unavailable right now.',
  'console.signups.auto.today': 'Auto-approved today: {count} of {cap}',
  'console.signups.auto.capReached': 'The daily cap is reached. New requests wait for tomorrow.',
  'console.signups.auto.state.label': 'State',
  'console.signups.auto.state.running': 'Running',
  'console.signups.auto.state.paused': 'Paused (kill switch)',
  'console.signups.auto.state.notRunning': 'Not running',
  'console.signups.auto.state.unknown': 'Unknown',
  'console.signups.auto.reason': 'Reason: {code}',
  'console.signups.auto.backlog': 'Older requests waiting for you: {count}',
  'console.signups.auto.value.unknown': 'unknown',
  'console.signups.verify.not_sent': 'No confirmation email is recorded as sent',
  'console.signups.verify.sent': 'Waiting for email confirmation (sent {time})',
  'console.signups.verify.confirmed_waiting_limit':
    "Email confirmed. Today's automatic approvals have no place left for this request. It can be approved automatically on a later day, or you can approve it now.",
  'console.signups.verify.confirmed': 'Email confirmed',
  'console.signups.verify.confirmed_queued': 'Email confirmed, waiting for the automatic approval',
  'console.signups.verify.confirmed_review': 'Email confirmed, needs your decision',
  'console.signups.verify.address_changed':
    'Address changed, needs review: the current address is not confirmed',
  'console.signups.verify.unknown': 'Email confirmation state is unknown',
  'console.signups.list.heading': 'Requests to handle',
  'console.signups.unconfirmed.heading': 'Not confirmed yet: {count}',
  'console.signups.unconfirmed.counted': 'Listed under "Not confirmed yet": {count}',
  'console.signups.confirmApprove.title': 'Approve the request of {name}?',
  'console.signups.confirmApprove.unconfirmed':
    'The email address has not been confirmed. Approving adds the account and sends the email to this address anyway.',
  'console.signups.confirmApprove.changed':
    'The address changed, and the current address has not been confirmed. Approving adds the account and sends the email to this address anyway.',
  'console.signups.confirmApprove.unknown':
    'We could not check whether the email address was confirmed. Approving adds the account and sends the email to this address anyway.',
  'console.signups.confirmApprove.ok': 'Approve anyway',
  'console.signups.safeguards.heading': 'Email confirmation and mail limits',
  'console.signups.safeguards.verifyToday': 'Confirmation emails today: {count} of {limit}',
  'console.signups.safeguards.verifyWaiting': 'Confirmed requests still waiting: {count}',
  'console.signups.safeguards.mailDay': 'Mail budget today: {count} of {limit}',
  'console.signups.safeguards.mail30d': 'Mail budget, last 30 days: {count} of {limit}',
  'console.signups.safeguards.paused.yes':
    'Paused: the kill switch stops confirmation emails and automatic approval.',
  'console.signups.safeguards.paused.no': 'Not paused.',
  'console.signups.safeguards.paused.unknown': 'Pause state is unknown.',
  'console.signups.sendAfter': 'Email scheduled for {time}',
  'console.signups.status.working': 'Working on it…',
  'console.signups.approve': 'Approve',
  'console.signups.reject': 'Reject',
  'console.signups.resend': 'Resend email',
  'console.signups.approveFor': 'Approve {name}',
  'console.signups.rejectFor': 'Reject {name}',
  'console.signups.resendFor': 'Resend email to {name}',
  'console.signups.confirm.title': 'Reject the request of {name}?',
  'console.signups.confirm.body':
    'No email will be sent to this person. The request will be closed.',
  'console.signups.confirm.ok': 'Reject request',
  'console.signups.done.approve': 'Approved {name}: the account was added and the email was sent.',
  'console.signups.done.approve.already_done': 'The request of {name} was already approved.',
  'console.signups.done.approve.email_not_resent':
    'The account of {name} exists. The email was not sent again.',
  'console.signups.done.approve.email_queued':
    'Approved {name}: the account was added. The email is scheduled and will be sent when quiet hours end.',
  'console.signups.done.resend.email_queued':
    'The email to {name} is scheduled and will be sent when quiet hours end.',
  'console.signups.done.approve.email_queued_cap':
    'Approved {name}: the account was added. The email waits because of the email limit and is normally sent automatically later.',
  'console.signups.done.approve.email_queued_wait':
    'Approved {name}: the account was added. The email is queued and has not been sent yet.',
  'console.signups.done.resend.email_queued_cap':
    'The email to {name} waits because of the email limit and is normally sent automatically later.',
  'console.signups.done.resend.email_held_paused':
    'The email to {name} is held: automatic approval is paused, or its pause state could not be checked safely. The email was not sent yet. It can be sent only when automatic approval is not paused and the pause check works.',
  'console.signups.done.approve.email_held_paused':
    'The email to {name} is held: automatic approval is paused, or its pause state could not be checked safely. The email was not sent yet. It can be sent only when automatic approval is not paused and the pause check works.',
  'console.signups.done.approve.unknown':
    'The request of {name} changed in a way this page does not know. Reload the page to see its current state.',
  'console.signups.done.reject.unknown':
    'The request of {name} changed in a way this page does not know. Reload the page to see its current state.',
  'console.signups.done.resend.unknown':
    'The request of {name} changed in a way this page does not know. Reload the page to see its current state.',
  'console.signups.done.resend.email_queued_wait':
    'The email to {name} is queued and has not been sent yet.',
  'console.signups.done.reject': 'Rejected the request of {name}. No email was sent.',
  'console.signups.done.resend': 'The email to {name} was sent.',
  'console.signups.err.account_pending':
    'The account for {name} is not ready yet. Try again in a moment.',
  'console.signups.err.bad_state': 'The request of {name} was already handled. Refresh the list.',
  'console.signups.err.email_failed_use_resend':
    'The account for {name} was added, but the email failed earlier. Use Resend email.',
  'console.signups.err.cap_reached':
    'All tester places are taken. Disable a tester first, then approve {name}.',
  'console.signups.err.account_error':
    'The account for {name} could not be added. Try again later.',
  'console.signups.err.email_failed':
    'The account for {name} was added, but the email could not be sent. Use Resend email.',
  'console.signups.err.email_failed.addrChanged':
    'The account for {name} was added, but no email was sent: the address on the request is not the one the account was added for. Resend will not help. Check the tester in Testers; if the request is wrong, delete it under "Stored requests and deletion".',
  'console.signups.err.email_failed.unbound':
    'The account for {name} was added, but the email was held: we have no record of the account for this address. Use Resend email again; if it fails again, check the server log.',
  'console.signups.err.email_failed.unproven':
    'The email to {name} was held: the address confirmation was not found. If you approve this person, use Resend email to send it on your approval.',
  'console.signups.err.email_failed.stateUnsafe':
    'The email to {name} was held: the sign-up state folder on the server is unsafe. Resend will fail until it is fixed. Check the server log.',
  'console.signups.err.email_failed.config':
    'The email to {name} was not sent: the email service is not set up correctly on the server. Resend will fail until it is fixed. Check the server log.',
  'console.signups.err.email_failed.refused':
    'The mail service refused the request to email {name}. Check the mail settings and the server log, then use Resend email.',
  'console.signups.err.email_failed.temporary':
    'Sending the email to {name} was not confirmed: the mail service may be temporarily unavailable. Try again later with Resend email.',
  'console.signups.err.not_found': 'The request of {name} no longer exists.',
  'console.signups.err.mail_cap':
    'The account for {name} was added. The email is waiting because of the email limit and is normally sent automatically later. If it stays waiting, check the server log. The daily and 30-day counts are under "Email confirmation and mail limits".',
  'console.signups.err.mail_cap.held':
    'The account for {name} was added. The email was not sent because of the email limit, and it is now held: automatic approval is paused, or its pause state could not be checked safely. It can be sent only when automatic approval is not paused and the pause check works.',
  'console.signups.err.unbound_state':
    "Warning: {name}'s request is marked as approved, but we have no record that the account was added. No email was sent. Check in Testers whether {name}'s account exists, then try again. If the warning returns, check free tester places and the server log.",
  'console.signups.err.not_found.unconfirmed':
    'Request of {name}: we could not confirm what happened. Sign-up administration may be off or unavailable on the server, so the request may still be stored. Use Refresh requests.',
  'console.signups.reloadNeeded': 'Reload needed',
  'console.signups.openStale':
    'The open requests could not be reloaded and may be out of date. Use Refresh requests.',
  'console.signups.all.heading': 'Stored requests and deletion',
  'console.signups.all.intro':
    "Every request we still hold, in any status. Use it to delete a person's request when they ask.",
  'console.signups.all.show': 'Show all stored requests',
  'console.signups.all.hide': 'Hide stored requests',
  'console.signups.all.filter': 'Filter by email',
  'console.signups.all.count': 'Showing {shown} of {total} stored requests',
  'console.signups.all.none': 'No stored requests.',
  'console.signups.all.noMatch': 'No stored request matches this email.',
  'console.signups.all.unavailable': 'Sign-up requests are not available right now.',
  'console.signups.all.stale':
    'The list could not be reloaded and may be out of date. Use Refresh requests.',
  'console.signups.all.id': 'Request ID',
  'console.signups.all.accountAdded': 'Account added',
  'console.signups.all.status.pending': 'Waiting for a decision',
  'console.signups.all.status.approved': 'Approved, not finished',
  'console.signups.all.status.rejected': 'Rejected',
  'console.signups.all.status.email_queued': 'Email scheduled',
  'console.signups.all.status.email_held': 'Email held',
  'console.signups.all.status.email_sent': 'Email sent',
  'console.signups.all.status.email_failed': 'Email failed',
  'console.signups.all.status.other': 'Unknown status',
  'console.signups.delete': 'Delete',
  'console.signups.delete.for': 'Delete request {id} of {address}',
  'console.signups.delete.working': 'Deleting…',
  'console.signups.delete.confirm.title': 'Delete this request?',
  'console.signups.delete.confirm.target': 'Request {id} of {address}',
  'console.signups.delete.confirm.body':
    'The stored request (name, email and answers) is removed. This cannot be undone.',
  'console.signups.delete.confirm.account':
    'An account was added for this request, and it stays after the deletion. To end its access, open Testers and use Disable.',
  'console.signups.delete.confirm.inFlight':
    'Warning: an account add for this request may still complete after the deletion. Check the Testers screen after a few minutes and use Disable if the account appears.',
  'console.signups.delete.confirm.noWarning':
    'The account warning no longer applies to this request.',
  'console.signups.delete.confirm.testers': 'Open Testers',
  'console.signups.delete.confirm.ok': 'Delete request',
  'console.signups.delete.done': 'Request {id}: deleted.',
  'console.signups.delete.gone': 'Request {id}: it was already gone.',
  'console.signups.delete.unconfirmed':
    'Request {id}: we could not confirm the deletion. The request may still be stored.',
  'console.signups.delete.rateLimited':
    'Request {id}: not deleted. Too many requests; wait a minute and try again.',
  'console.signups.delete.rateLimitedFor':
    'Request {id}: not deleted. Too many requests; try again later. Seconds to wait: {seconds}.',
  'console.signups.delete.failed.server':
    'Request {id}: the deletion did not finish. Press "Refresh requests"; if the request is still there, try again. If not, ask the operator to check the server log.',
  'console.signups.delete.failed.network':
    'Request {id}: the server did not answer, so it may or may not be deleted. Press "Refresh requests" to check, then try again if it is still there.',
  'console.signups.delete.failed.csrf':
    'Request {id}: not deleted. The server refused it as not coming from this app. Reload the page and try again.',
  'console.signups.delete.failed.forbidden':
    'Request {id}: not deleted. Only the owner can delete requests.',
  'console.signups.delete.failed.signed_out':
    'Request {id}: not deleted. Your sign-in has expired; sign in again.',
  'console.signups.delete.failed.unavailable':
    'Request {id}: not deleted. The service is not available right now; try again later.',
  'console.signups.delete.failed.off':
    'Request {id}: not deleted. Sign-up administration is off or unavailable on the server, so the request may still be stored.',
  'console.signups.delete.failed.invalid_id':
    'Request {id}: not deleted. This request ID is not valid.',
} as const;

export type ConsoleMessageKey = keyof typeof consoleEn;
