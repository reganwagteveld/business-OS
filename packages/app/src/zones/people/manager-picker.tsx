import { Field, Input, Select } from '@business-os/ui';
import { useEffect, useState } from 'react';
import type { PeopleClient } from '../../api/people';
import { useLoad } from '../use-load';

/**
 * Chooses a manager from the People directory, searched on the server (25 at a time), never loading
 * the whole workforce. Terminated people are not offered (the API refuses them too), nor is the
 * employee themselves. The server still checks self, terminated managers and reporting-line cycles.
 */
export function ManagerPicker({ client, slug, excludeId, value, valueLabel, onChange, error, label = 'Reports to' }: {
  client: PeopleClient; slug: string; excludeId?: string; value: string; valueLabel?: string | null;
  onChange: (id: string, name: string) => void; error?: string; label?: string;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const { state } = useLoad(`manager-choices|${slug}|${q}`, (signal) => client.list(slug, { status: 'current', q: q || undefined, sort: 'name', limit: 25 }, signal));
  const found = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data.employees.filter((e) => e.id !== excludeId) : [];
  const loading = state.status === 'loading';
  const failed = state.status === 'done' && state.outcome.kind !== 'ok';
  const selectedMissing = value && !found.some((e) => e.id === value);
  return (
    <div className="grid gap-3">
      <Field label="Find a person" hint={failed ? 'Could not load people. Try again.' : loading ? 'Searching…' : 'Type part of a name, number or email.'}>
        {(c) => <Input {...c} type="search" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />}
      </Field>
      <Field label={label} error={error}>{(c) => (
        <Select {...c} value={value} onChange={(e) => onChange(e.target.value, found.find((x) => x.id === e.target.value)?.displayName ?? '')}>
          <option value="">No manager</option>
          {selectedMissing ? <option value={value}>{valueLabel ?? 'Current manager'}</option> : null}
          {found.map((e) => <option key={e.id} value={e.id}>{e.displayName}{e.jobTitle ? `, ${e.jobTitle}` : ''}</option>)}
        </Select>
      )}</Field>
    </div>
  );
}
