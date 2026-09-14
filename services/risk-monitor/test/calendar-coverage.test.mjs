import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarStatus, sessionAt, nextSessionOpen} from '../src/calendar.mjs';

const unix = value => Date.parse(value) / 1000;
test('reviewed future regular sessions stay available across year and DST boundaries', () => {
  for (const at of ['2027-01-04T15:00:00Z', '2027-03-15T13:35:00Z', '2027-11-08T14:35:00Z',
    '2027-12-31T15:00:00Z', '2028-01-03T15:00:00Z']) {
    assert.equal(sessionAt(unix(at)).open, true, at);
  }
  // NYSE does not observe Saturday Jan 1, 2028 on Friday Dec 31, 2027.
  assert.equal(nextSessionOpen(unix('2027-12-30T22:00:00Z')), unix('2027-12-31T14:35:00Z'));
});

test('future observed holidays and half days retain conservative close boundaries', () => {
  for (const date of ['2027-03-26', '2027-06-18', '2027-07-05', '2027-12-24',
    '2028-04-14', '2028-06-19', '2028-07-04', '2028-12-25']) {
    for (const policy of ['regular', 'equities-24x5']) {
      assert.equal(sessionAt(unix(`${date}T15:00:00Z`), policy).reason, 'market_closed', `${date} ${policy}`);
      assert.equal(sessionAt(unix(`${date}T15:00:00Z`), policy).open, false, `${date} ${policy}`);
    }
  }
  for (const [date, hour] of [['2027-11-26', 17], ['2028-07-03', 16], ['2028-11-24', 17]]) {
    assert.equal(sessionAt(unix(`${date}T${hour}:49:59Z`)).open, true);
    assert.equal(sessionAt(unix(`${date}T${hour}:50:00Z`)).open, false);
    assert.equal(sessionAt(unix(`${date}T${hour + 1}:00:00Z`), 'equities-24x5').open, false);
  }
});

test('calendar expiry is exposed with ninety days of advance notice', () => {
  const expiry=unix('2029-01-01T01:00:00Z');
  assert.equal(calendarStatus(expiry-91*86400).expiring, false);
  assert.equal(calendarStatus(expiry-90*86400).expiring, true);
  assert.equal(calendarStatus(expiry-1).expired, false);
  assert.equal(calendarStatus(expiry).expired, true);
  assert.equal(calendarStatus(expiry+86400).daysRemaining, 0);
});

test('overnight trading uses the reviewed trading date and unknown years fail closed', () => {
  assert.equal(sessionAt(unix('2027-01-04T01:00:00Z'), 'equities-24x5').open, true);
  assert.equal(sessionAt(unix('2027-01-01T01:00:00Z'), 'equities-24x5').reason, 'market_closed');
  assert.equal(sessionAt(unix('2029-01-01T01:00:00Z'), 'equities-24x5').reason, 'calendar_expired');
  assert.equal(sessionAt(unix('2029-01-02T15:00:00Z')).reason, 'calendar_expired');
  assert.equal(sessionAt(unix('2025-12-31T15:00:00Z')).reason, 'calendar_expired');
});
