// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Alert, AlertTitle, Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger,
  EmptyState, Field, FormSection, Input, PageHeader, Select, Separator, Spinner, StatCard,
} from '../src';

afterEach(cleanup);

function ConfirmDialog({ onArchive = () => {} }: { onArchive?: () => void }) {
  return (
    <>
      <Button>Before</Button>
      <Dialog>
        <DialogTrigger asChild><Button variant="secondary">Archive customer</Button></DialogTrigger>
        <DialogContent>
          <DialogTitle>Archive this customer?</DialogTitle>
          <DialogDescription>They will be hidden from lists.</DialogDescription>
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost" autoFocus>Keep customer</Button></DialogClose>
            <DialogClose asChild><Button variant="destructive" onClick={onArchive}>Archive</Button></DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is labelled by its title and described by its description', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);
    await user.click(screen.getByRole('button', { name: 'Archive customer' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive this customer?' });
    expect(dialog).toHaveProperty('ariaModal', null); // Radix hides the rest of the page instead
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('They will be hidden from lists.').id);
  });

  it('moves focus in on open and keeps Tab and Shift+Tab inside', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);
    await user.click(screen.getByRole('button', { name: 'Archive customer' }));
    const keep = screen.getByRole('button', { name: 'Keep customer' });
    const archive = screen.getByRole('button', { name: 'Archive' });
    expect(document.activeElement).toBe(keep);
    await user.tab();
    expect(document.activeElement).toBe(archive);
    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(archive);
  });

  it('hides the page behind it from assistive technology while open', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);
    await user.click(screen.getByRole('button', { name: 'Archive customer' }));
    expect(screen.queryByRole('button', { name: 'Before' })).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(<ConfirmDialog onArchive={onArchive} />);
    const trigger = screen.getByRole('button', { name: 'Archive customer' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('runs the chosen action, closes, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(<ConfirmDialog onArchive={onArchive} />);
    const trigger = screen.getByRole('button', { name: 'Archive customer' });
    await user.click(trigger);
    await user.keyboard('{Tab}{Enter}');
    expect(onArchive).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('when controlled without a trigger, returns focus to whatever opened it', async () => {
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Delete row</Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Delete this row?</DialogTitle>
              <DialogDescription>This cannot be undone.</DialogDescription>
              <DialogClose asChild><Button>Cancel</Button></DialogClose>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Controlled />);
    const opener = screen.getByRole('button', { name: 'Delete row' });
    await user.click(opener);
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toBe(document.activeElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Button', () => {
  it('activates with Enter and Space from the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('cannot be focused or activated while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Save</Button>);
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('while loading is disabled, busy and keeps its accessible name', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save invoice</Button>);
    const button = screen.getByRole('button', { name: 'Save invoice' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has an outline variant', () => {
    render(<Button variant="outline">Filter</Button>);
    expect(screen.getByRole('button', { name: 'Filter' }).className).toContain('border-input');
  });
});

describe('Forms', () => {
  function InvoiceForm({ onSubmit }: { onSubmit: (data: Record<string, string>) => void }) {
    const [error, setError] = useState<string>();
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          if (!data.amount) return setError('Enter an amount');
          setError(undefined);
          onSubmit(data);
        }}
      >
        <FormSection title="Invoice details" description="Shown on the invoice">
          <Field label="Customer">{(p) => <Select {...p} name="customer" defaultValue="hp"><option value="hp">Harbour &amp; Pine</option><option value="nl">Northlight</option></Select>}</Field>
          <Field label="Amount" hint="Excluding VAT" error={error}>{(p) => <Input {...p} name="amount" />}</Field>
        </FormSection>
        <Button variant="ghost">Preview</Button>
        <Button type="submit">Save</Button>
      </form>
    );
  }

  it('groups fields under a named section', () => {
    render(<InvoiceForm onSubmit={() => {}} />);
    const group = screen.getByRole('group', { name: 'Invoice details' });
    expect(within(group).getByLabelText('Amount')).toBeTruthy();
  });

  it('focuses the control when its label is clicked and exposes the hint', async () => {
    const user = userEvent.setup();
    render(<InvoiceForm onSubmit={() => {}} />);
    await user.click(screen.getByText('Amount'));
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    expect(document.activeElement).toBe(amount);
    expect(amount.getAttribute('aria-describedby')).toBe(screen.getByText('Excluding VAT').id);
  });

  it('shows an announced, linked error and marks the field invalid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvoiceForm onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    expect(amount.getAttribute('aria-invalid')).toBe('true');
    expect(amount.getAttribute('aria-describedby')).toContain(screen.getByText('Enter an amount').id);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits typed and selected values with Enter; plain buttons never submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<InvoiceForm onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(onSubmit).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Customer' }), 'nl');
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '4820{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ customer: 'nl', amount: '4820' });
  });
});

describe('Feedback and layout', () => {
  it('announces loading and alerts with the right politeness', () => {
    render(
      <>
        <Spinner label="Loading customers" />
        <Alert tone="danger"><AlertTitle>Payment failed</AlertTitle></Alert>
        <Alert tone="success"><AlertTitle>Invoice sent</AlertTitle></Alert>
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Payment failed');
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual(['Loading customers', 'Invoice sent']);
  });

  it('gives a page one h1 and keeps decorative separators out of the accessibility tree', () => {
    render(
      <>
        <PageHeader title="Customers" description="Everyone you work with" actions={<Button>New customer</Button>} />
        <Separator />
        <Separator decorative={false} />
        <EmptyState title="No customers yet" action={<Button>Add a customer</Button>} />
        <StatCard label="Revenue" value="£48,210" change="+12% vs last month" trend="up" />
      </>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeTruthy();
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    expect(screen.getByText('+12% vs last month').className).toContain('text-success');
  });
});
