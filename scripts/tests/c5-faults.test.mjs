/** The C-5 fault drills' verdict (runtime/tests/c5-faults.ts): only drills that ran are judged. */
import { describe, expect, it } from 'vitest';
import { capacityFaultFailures, deployedFaultFailures } from '../../runtime/tests/c5-faults.ts';

describe('deployed fault drills', () => {
  const stop = { status: 200, recreated: 201 };
  const crash = { reported: { state: 'failed' }, unitGone: true, recreated: 201 };
  it('passes the drills that ran (N=1 runs no crash drill)', () => {
    expect(deployedFaultFailures({})).toEqual([]);
    expect(deployedFaultFailures({ stop })).toEqual([]);
    expect(deployedFaultFailures({ stop, crash })).toEqual([]);
  });
  it.each([
    ['stop', { ...stop, status: 500 }],
    ['stop', { ...stop, recreated: 429 }],
    ['crash', { ...crash, reported: null }],
    ['crash', { ...crash, unitGone: false }],
    ['crash', { ...crash, recreated: 0 }],
  ])('fails a %s drill that did not recover or clean up: %o', (name, drill) => {
    expect(deployedFaultFailures({ stop, [name]: drill })).toEqual([name]);
  });
});

describe('capacity fault drills', () => {
  const stop = { state: 'ended', runtimeGone: true };
  const crash = { state: 'failed', runtimeGone: true };
  const running = [{ replaces: 1, state: 'running' }];
  it('passes the drills that ran; a replacement the next drill killed is not judged', () => {
    expect(capacityFaultFailures({}, [])).toEqual([]);
    expect(capacityFaultFailures({ stop }, running)).toEqual([]);
    const killed = { replaces: 0, state: 'failed', fault: 'crashed' };
    expect(capacityFaultFailures({ stop, crash }, [killed, ...running])).toEqual([]);
  });
  it.each([
    ['stop', { stop: { ...stop, runtimeGone: false } }, running],
    ['stop', { stop: { ...stop, state: 'failed' } }, running],
    ['crash', { crash: { ...crash, runtimeGone: false } }, running],
    ['crash', { crash: { ...crash, state: 'running' } }, running],
    ['replacement', { stop }, [{ replaces: 0, state: 'failed' }]],
    ['replacement', { stop }, []],
  ])('fails: %s', (name, faults, sessions) => {
    expect(capacityFaultFailures(faults, sessions)).toEqual([name]);
  });
});
