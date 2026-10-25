import { appendCustomerResponseText } from './customer-response-text.js';

export const appendCustomerCorrections = (doc: Document, host: HTMLElement, text: string) =>
  appendCustomerResponseText(doc,host,text,'Requested corrections','Read full corrections');
