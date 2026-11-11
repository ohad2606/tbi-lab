/**
 * TBI Admin's own English texts. The administration's shared texts (admin.*, the report kinds
 * and areas) come from @tbi-lab/admin-client, the same as the Lab's; these are the app's screens.
 */
export const consoleEn = {
  'console.appName': 'TBI Admin',
  'console.skip': 'Skip to content',
  'console.nav.label': 'Sections',
  'console.nav.today': 'Today',
  'console.nav.testers': 'Testers',
  'console.nav.add': 'Add tester',
  'console.nav.feedback': 'Feedback',
  'console.nav.activity': 'Activity log',
  'console.nav.settings': 'Settings',
  'console.refresh': 'Refresh',

  'console.access.signedOut.title': 'You are signed out',
  'console.access.signedOut.text': 'Your sign-in has expired or you are not signed in.',
  'console.access.signIn': 'Sign in again',
  'console.access.forbidden.title': 'No access',
  'console.access.forbidden.text':
    'This Google account cannot use TBI Admin. Sign out to use another account.',
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

  'console.tester.back': 'All testers',
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
  'console.feedback.new': 'New',
  'console.feedback.newNote': 'New: not opened yet on this device.',

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

  'console.settings.heading': 'Settings',
  'console.settings.language': 'Language',
  'console.settings.signOut': 'Sign out',
  'console.settings.signOutHint': 'Ends your TBI Admin sign-in in this browser.',
} as const;

export type ConsoleMessageKey = keyof typeof consoleEn;
