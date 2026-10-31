/** Sprint 25 closure: the build-record rollback tool (records.ts), bundled for the deploy kit. */
import { main } from './records.js';

process.exitCode = main(process.argv.slice(2));
