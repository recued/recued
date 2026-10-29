import { mountReminderCreateForm } from '../reminders/reminder-create-form.js';

/** Automation keeps its alarm vocabulary while sharing the reminder creation flow. */
export const mountAlarmScheduleForm = (options: Parameters<typeof mountReminderCreateForm>[0]) =>
  mountReminderCreateForm({ ...options, kind: 'alarm' });
