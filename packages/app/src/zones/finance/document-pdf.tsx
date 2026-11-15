import type { FinanceDocument } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field,
  Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from '@business-os/ui';
import { useEffect, useRef, useState } from 'react';
import type { DocumentPdfVersion, FetchedFile, PdfVersionList } from '../../api/finance';
import type { Outcome } from '../../api/tenancy';
import { useLoad } from '../use-load';
import { useFinance } from './env';
import { formatWhen } from './format';
import { describeFailure, KIND_LABEL, LoadingRows, useSubmit } from './shared';

// Finance F5 (docs/finance-documents-f5.md §8): the PDF of a quote or invoice. A draft has a watermarked
// preview that is never stored. A numbered document keeps an immutable original (version 1) and any
// later versions, each with a reason. Nothing here sends a document or records that it was sent.

type PdfPath = 'quotes' | 'invoices';
type NewReason = 'BRANDING_UPDATED' | 'TEMPLATE_UPDATED' | 'RENDERING_CORRECTION' | 'OTHER';

export const REASON_LABEL: Record<DocumentPdfVersion['reason'], string> = {
  ORIGINAL: 'Original',
  BRANDING_UPDATED: 'Branding updated',
  TEMPLATE_UPDATED: 'Template updated',
  RENDERING_CORRECTION: 'Rendering correction',
  OTHER: 'Other',
};

const UNSUPPORTED = 'Some text uses characters the PDF fonts cannot show (for example Chinese, Japanese, Korean, Arabic or Hebrew script). They are printed as □. Check the PDF before you share it.';

const STATUS_WORD: Record<string, string> = { ISSUED: 'issued', ACCEPTED: 'accepted', DECLINED: 'declined', EXPIRED: 'expired', VOID: 'void' };

/** Failure wording for the file calls: a 503 means rendering failed and nothing was stored. */
function fileFailure(out: Outcome<unknown>): string {
  if (out.kind === 'failed' && out.status === 503) return 'The PDF could not be made right now. Nothing was stored. Try again in a moment.';
  if (out.kind === 'invalid') return 'Business OS sent back something that is not a PDF. Nothing was saved. Try again.';
  if (out.kind === 'unreachable') return 'Business OS could not be reached. Check your connection and try again.';
  return describeFailure(out);
}

const objectUrl = (blob: Blob): string | null => (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null);
const revoke = (url: string | null) => {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
};

/**
 * Points an element (an iframe or img) at a local blob URL, and releases the URL when the bytes change or
 * the element goes away. The URL is set on the element directly, so a remount (Strict Mode) gets a fresh one.
 */
export function useBlobSource<E extends HTMLIFrameElement | HTMLImageElement>(blob: Blob | null) {
  const ref = useRef<E | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!blob || !el) return;
    const u = objectUrl(blob);
    if (u) el.src = u;
    return () => revoke(u);
  }, [blob]);
  return ref;
}

/** Saves the bytes under the server's file name. The browser shows its own download prompt or bar. */
function saveFile(file: FetchedFile, fileName: string) {
  const url = objectUrl(file.blob);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start reading the blob before it is released.
  setTimeout(() => revoke(url), 30_000);
}

/** The PDF card on a quote or invoice. Hidden entirely without any of the three PDF permissions. */
export function DocumentPdfCard({ doc }: { doc: FinanceDocument }) {
  const { can } = useFinance();
  if (doc.kind === 'CREDIT_NOTE') return null;
  if (!can.pdfPreview && !can.pdfDownload && !can.pdfGenerate) return null;
  const path: PdfPath = doc.kind === 'QUOTE' ? 'quotes' : 'invoices';
  if (doc.status === 'DRAFT') return <DraftPdfCard doc={doc} path={path} />;
  // A discarded draft was never numbered: it has no PDF.
  if (!doc.number) return null;
  return <IssuedPdfCard doc={doc} path={path} />;
}

function DraftPdfCard({ doc, path }: { doc: FinanceDocument; path: PdfPath }) {
  const env = useFinance();
  const [open, setOpen] = useState(false);
  if (!env.can.pdfPreview) return null;
  const label = KIND_LABEL[doc.kind].toLowerCase();
  return (
    <Card>
      <CardHeader><CardTitle>PDF</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Preview how this {label} will look. The preview is marked DRAFT and is not kept. A PDF is kept once the {label} is issued.</p>
        <Button variant="outline" onClick={() => setOpen(true)}>Preview draft PDF</Button>
      </CardContent>
      {open ? (
        <PdfViewer
          title={`Draft ${label} preview`} fileName={null}
          load={(signal) => env.client.draftPdf(env.slug, path, doc.id, signal)} onClose={() => setOpen(false)}
        />
      ) : null}
    </Card>
  );
}

function IssuedPdfCard({ doc, path }: { doc: FinanceDocument; path: PdfPath }) {
  const env = useFinance();
  const { client, slug, can, locale, timeZone } = env;
  const list = useLoad(`pdfs|${slug}|${path}|${doc.id}`, (signal) => client.pdfVersions(slug, path, doc.id, signal));
  const [viewing, setViewing] = useState<DocumentPdfVersion | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const label = KIND_LABEL[doc.kind].toLowerCase();

  const shown: PdfVersionList | null = list.state.status === 'done' ? (list.state.outcome.kind === 'ok' ? list.state.outcome.data : null) : list.previous?.kind === 'ok' ? list.previous.data : null;
  // Newest first, whatever order the server used.
  const versions = [...(shown?.versions ?? [])].sort((a, b) => b.versionNumber - a.versionNumber);
  const latest = versions[0] ?? null;

  /** Runs one action at a time; every failure is shown in words, never thrown. */
  async function guarded(key: string, work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch {
      setError('Something went wrong. Reload and try again.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const preview = (v: DocumentPdfVersion) => guarded('preview', async () => setViewing(v));

  const download = (v: DocumentPdfVersion, key = v.id) => guarded(`download:${key}`, async () => {
    const out = await client.pdfFile(slug, path, doc.id, v.id, 'download');
    if (out.kind !== 'ok') {
      if (out.kind === 'unauthenticated') env.onSessionEnded();
      setError(fileFailure(out));
      return;
    }
    saveFile(out.data, v.fileName);
    setNotice({ tone: 'success', text: `Downloaded ${v.fileName}.` });
  });

  const body = () => {
    if (!shown) {
      if (list.state.status === 'loading') return <LoadingRows label="Loading PDFs…" rows={2} />;
      const out = list.state.outcome;
      if (out.kind === 'unauthenticated') env.onSessionEnded();
      return (
        <Alert tone="danger"><AlertDescription>
          The PDF history could not be loaded. {fileFailure(out)} <button type="button" className="font-medium underline underline-offset-2" onClick={list.reload}>Try again</button>
        </AlertDescription></Alert>
      );
    }
    if (versions.length === 0) {
      // Every quote or invoice issued since F5 has its original from the moment it was issued.
      return <p className="text-sm text-muted-foreground">This {label} was issued before PDFs were kept, so it has no original PDF.</p>;
    }
    return (
      <Table aria-label="PDF versions">
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead><TableHead>Reason</TableHead><TableHead className="hidden sm:table-cell">Created</TableHead>
            <TableHead className="hidden md:table-cell">File</TableHead><TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.map((v) => (
            <TableRow key={v.id}>
              <TableCell className="whitespace-nowrap">
                v{v.versionNumber}{v.id === latest?.id && versions.length > 1 ? <Badge tone="brand" className="ml-2">Latest</Badge> : null}
              </TableCell>
              <TableCell className="[overflow-wrap:anywhere]">
                {REASON_LABEL[v.reason]}{v.reasonNote ? <span className="block text-xs text-muted-foreground">{v.reasonNote}</span> : null}
                <span className="block text-xs text-muted-foreground">
                  {v.reason === 'ORIGINAL' ? 'Made when issued' : `Made while ${STATUS_WORD[v.documentStatus] ?? v.documentStatus.toLowerCase()}`}
                </span>
                {v.unsupportedCharacters ? <Badge tone="warning" className="mt-1">Some characters shown as □</Badge> : null}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap sm:table-cell">{formatWhen(v.createdAt, timeZone, locale)}</TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="[overflow-wrap:anywhere]">{v.fileName}</span>
                <span className="block text-xs text-muted-foreground">{v.pageCount} {v.pageCount === 1 ? 'page' : 'pages'} · {formatSize(v.byteSize)}</span>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap">
                {can.pdfPreview ? <Button size="sm" variant="ghost" onClick={() => void preview(v)} disabled={busy !== null} aria-label={`Preview version ${v.versionNumber}`}>Preview</Button> : null}
                {can.pdfDownload ? (
                  <Button size="sm" variant="ghost" onClick={() => void download(v)} loading={busy === `download:${v.id}`} disabled={busy !== null} aria-label={`Download version ${v.versionNumber}`}>Download</Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>PDF</CardTitle>
        <div className="flex flex-wrap gap-2">
          {latest && can.pdfGenerate ? <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={busy !== null}>New version</Button> : null}
          {can.pdfPreview && latest ? (
            <Button size="sm" variant="outline" onClick={() => void preview(latest)} loading={busy === 'preview'} disabled={busy !== null}>Preview PDF</Button>
          ) : null}
          {can.pdfDownload && latest ? (
            <Button size="sm" onClick={() => void download(latest, 'latest')} loading={busy === 'download:latest'} disabled={busy !== null}>Download PDF</Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <Alert tone="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert tone={notice.tone}><AlertDescription>{notice.text}</AlertDescription></Alert> : null}
        {latest?.unsupportedCharacters ? <Alert tone="warning"><AlertDescription>{UNSUPPORTED}</AlertDescription></Alert> : null}
        {body()}
        {versions.length ? (
          <p className="text-xs text-muted-foreground">
            The original was made when this {label} was issued. Each version is kept exactly as it was made and never changes. Downloading a PDF does not send it to anyone.
          </p>
        ) : null}
      </CardContent>
      {viewing ? (
        <PdfViewer
          title={`${doc.number} · version ${viewing.versionNumber}`} fileName={viewing.fileName}
          load={(signal) => client.pdfFile(slug, path, doc.id, viewing.id, 'preview', signal)}
          onDownload={can.pdfDownload ? () => void download(viewing) : undefined}
          onClose={() => setViewing(null)}
        />
      ) : null}
      {adding && latest ? (
        <NewVersionDialog
          doc={doc} path={path} latest={latest} onClose={() => setAdding(false)}
          onReload={() => { setAdding(false); list.reload(); }}
          onDone={(v) => {
            setAdding(false);
            list.reload();
            setNotice(v.unsupportedCharacters
              ? { tone: 'warning', text: `Version ${v.versionNumber} was created. Some text uses characters the PDF font cannot show. Check it before you share it.` }
              : { tone: 'success', text: `Version ${v.versionNumber} was created. Earlier versions are unchanged.` });
          }}
        />
      ) : null}
    </Card>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shows a PDF in a sandboxed frame from a local blob URL. The URL is released when the viewer closes. */
function PdfViewer({ title, fileName, load, onDownload, onClose }: {
  title: string; fileName: string | null; load: (signal: AbortSignal) => Promise<Outcome<FetchedFile>>; onDownload?: () => void; onClose: () => void;
}) {
  const env = useFinance();
  const state = useLoad(`pdfview|${title}`, load);
  const file = state.state.status === 'done' && state.state.outcome.kind === 'ok' ? state.state.outcome.data : null;
  const frame = useBlobSource<HTMLIFrameElement>(file?.blob ?? null);
  const canShow = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  const failed = state.state.status === 'done' && state.state.outcome.kind !== 'ok' ? state.state.outcome : null;
  useEffect(() => {
    if (failed?.kind === 'unauthenticated') env.onSessionEnded();
  }, [failed, env]);
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="flex h-[min(90vh,60rem)] max-w-4xl flex-col">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{fileName ?? 'Draft preview. It is marked DRAFT and is not kept.'}</DialogDescription>
        {file?.unsupportedCharacters ? <Alert tone="warning" className="mt-3"><AlertDescription>{UNSUPPORTED}</AlertDescription></Alert> : null}
        <div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted">
          {failed ? (
            <div className="p-4">
              <Alert tone="danger" role="alert"><AlertDescription>
                The PDF could not be shown. {fileFailure(failed)} <button type="button" className="font-medium underline underline-offset-2" onClick={state.reload}>Try again</button>
              </AlertDescription></Alert>
            </div>
          ) : file && canShow ? (
            <iframe ref={frame} title={title} className="size-full" />
          ) : file ? (
            <p className="p-4 text-sm text-muted-foreground">This device cannot show the PDF here. Download it instead.</p>
          ) : (
            <div className="p-4"><LoadingRows label="Preparing the PDF…" rows={3} /></div>
          )}
        </div>
        {file && canShow ? <p className="mt-2 text-xs text-muted-foreground">If the PDF does not appear, {onDownload ? 'use Download to open it in your PDF viewer' : 'this device cannot show it here'}.</p> : null}
        <DialogFooter>
          {onDownload ? <Button variant="outline" onClick={onDownload}>Download</Button> : null}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewVersionDialog({ doc, path, latest, onClose, onDone, onReload }: {
  doc: FinanceDocument; path: PdfPath; latest: DocumentPdfVersion; onClose: () => void; onDone: (v: DocumentPdfVersion) => void; onReload: () => void;
}) {
  const env = useFinance();
  const submit = useSubmit(env.onSessionEnded);
  const [reason, setReason] = useState<NewReason>('BRANDING_UPDATED');
  const [note, setNote] = useState('');
  const missing = reason === 'OTHER' && note.trim() === '';
  return (
    <Dialog open onOpenChange={(open) => (!open && !submit.busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>Create a new PDF version?</DialogTitle>
        <DialogDescription>
          Version {latest.versionNumber + 1} is made from the {KIND_LABEL[doc.kind].toLowerCase()} as issued, with your current branding. The figures, customer and
          seller details do not change. Every earlier version, including the original, is kept exactly as it is.
        </DialogDescription>
        <div className="mt-4 grid gap-3">
          <Field label="Reason">
            {(c) => (
              <Select {...c} value={reason} onChange={(e) => setReason(e.target.value as NewReason)}>
                <option value="BRANDING_UPDATED">Branding updated</option>
                <option value="TEMPLATE_UPDATED">Template updated</option>
                <option value="RENDERING_CORRECTION">Rendering correction</option>
                <option value="OTHER">Other</option>
              </Select>
            )}
          </Field>
          <Field label={reason === 'OTHER' ? 'Note' : 'Note (optional)'} hint="Kept with the version." error={submit.fields.note}>
            {(c) => <Textarea {...c} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
        {submit.error ? (
          <Alert tone="danger" className="mt-4" role="alert">
            <AlertDescription>
              {submit.stale ? 'Someone else created a version since you opened this. Reload to see it, then decide whether you still need a new one.' : submit.error}
              {submit.stale ? <> <button type="button" className="font-medium underline underline-offset-2" onClick={onReload}>Reload</button></> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.busy}>Cancel</Button>
          <Button
            loading={submit.busy} disabled={missing}
            onClick={() => void submit.run(
              () => env.client.createPdfVersion(env.slug, path, doc.id, { mode: 'new_version', reason, note: note.trim(), basedOnVersion: latest.versionNumber }),
              (out) => onDone(out.data),
            )}
          >
            Create version {latest.versionNumber + 1}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
