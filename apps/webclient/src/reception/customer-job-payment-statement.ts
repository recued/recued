import { jobStatementDocument } from './customer-financial-document.js';
import { customerJobPaymentStatementLines,type Conn,type ServerRpcRegistry,type CustomerJobPaymentStatement } from '@recued/contracts';
import type { MailComposeDeps } from '../mail/mail-compose-host.js';
import { customerStatementHtml,mountCustomerStatementView } from './customer-statement-view.js';

export type CustomerJobPaymentStatementConn = Conn<Pick<ServerRpcRegistry,
  'reception.jobs.payment.statement' | 'reception.jobs.payment.statement.draft'>>;
export const customerJobPaymentStatementHtml = (statement: CustomerJobPaymentStatement) =>
  customerStatementHtml('Customer job payment statement',customerJobPaymentStatementLines(statement),jobStatementDocument(statement));
export const mountCustomerJobPaymentStatement = (opts: {
  host: HTMLElement;document: Document;conn: CustomerJobPaymentStatementConn;mail?: MailComposeDeps;canReviewEmail?: () => boolean;
}) => mountCustomerStatementView<CustomerJobPaymentStatement>({ ...opts,kind: 'job-payment',
  read: id => opts.conn('reception.jobs.payment.statement',{ job_id: id }),
  prepare: (statement,sender,recipient) => opts.conn('reception.jobs.payment.statement.draft',{ job_id: statement.job_id,
    expected_statement_hash: statement.statement_hash,sender_mail_instance: sender,recipient_email: recipient }),
  validate: (result,id) => result.format === 'recued.customer-job-payment-statement' && [1,2,3,4].includes(result.version)
    && result.job_id === id && result.invoices.length > 0 && result.invoices.length <= 100,
  documentModel: jobStatementDocument,lines: customerJobPaymentStatementLines,heading: result => `Job payment statement — ${result.quote_label} — ${result.customer}`,
});
