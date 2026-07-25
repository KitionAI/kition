# Lead Automation

This guide demonstrates a complete record-triggered workflow without exposing setup files or implementation fixtures.

## Included workflow

- Trigger: a record is created in `Leads`
- Action: send an email to `sales@kition.ai`
- Subject: `New Lead Submission Notification`
- Body: First Name, Last Name, Work Email, Company Name, Job Title, Reason for Contact, and Additional Notes
- Initial state: off

Open `Lead Follow-up.kitable`, then select **Workflows**. Kition creates the workflow on first open and binds every body token to the imported table's real field IDs.

## Inspect it safely

The workflow is off by default. You can inspect the trigger, action, subject, and field-reference chips without configuring anything.

Use the action preview for a side-effect-free render. Configure an email connection only when you are ready to send a real test or enable the workflow.

See [[../Email Automation/intro.md]] for inbox sync, SMTP settings, common provider values, and a safe test sequence.

## Adapt it

Change the recipient, subject, or body fields to match your own intake table. The same structure works for sales leads, support tickets, job applications, and approval requests.
