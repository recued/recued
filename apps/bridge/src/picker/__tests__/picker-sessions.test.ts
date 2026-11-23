import { expect, it } from 'vitest';
import { createPickerSessions } from '../picker-sessions.js';
import { PICKER_RESULT_MESSAGE_TYPE } from '../picker-protocol.js';

it('binds a launch to the paired runtime even if a replacement has the same document and URL', () => {
  const first = {}, second = {};
  const sessions = createPickerSessions<object>(() => 1);
  const launch = sessions.begin(first);
  sessions.bind(launch, first, { tab_id: 1, document_id: 'doc', page_url: 'https://example.com/' });
  const message = { type: PICKER_RESULT_MESSAGE_TYPE, launch_id: launch.launch_id, result: { status: 'cancelled' as const } };
  const sender = { tab: { id: 1 }, frameId: 0, documentId: 'doc', url: 'https://example.com/' };
  expect(sessions.consume(message, sender, second).ok).toBe(false);
  sessions.retire();
  sessions.begin(first);
  expect(sessions.consume(message, sender, first).ok).toBe(false);
});
