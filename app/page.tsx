import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const checks = [
  ['Profile structure', '18 fields'],
  ['Evaluate release policy', '7 checks'],
  ['Protect sensitive values', 'Before AI'],
] as const;

export default function Home() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border/90 bg-card/95">
        <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold leading-tight">DataPilot</p>
              <p className="text-xs text-muted-foreground">Dataset release desk</p>
            </div>
          </div>
          <Badge className="bg-policy-tint text-policy ring-1 ring-policy/15">
            Explainable by design
          </Badge>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-7 sm:px-6 sm:py-10 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <section aria-labelledby="page-title" className="min-w-0">
          <div className="mb-7 max-w-2xl">
            <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              New release assessment
            </p>
            <h1
              id="page-title"
              className="text-balance text-[clamp(2rem,7vw,3.4rem)] font-semibold leading-[1.02] tracking-[-0.04em]"
            >
              Can this dataset ship today?
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Turn quality findings into reviewable, executable, and auditable release decisions.
            </p>
          </div>

          <Card className="border border-border bg-card shadow-[0_16px_50px_rgb(16_35_30/6%)] ring-0">
            <CardHeader className="border-b border-border/80 pb-4">
              <div className="mb-3 flex size-11 items-center justify-center rounded-[14px] bg-policy-tint text-policy">
                <FileSpreadsheet aria-hidden="true" className="size-5" />
              </div>
              <CardTitle className="text-xl">Analyze a CSV release candidate</CardTitle>
              <CardDescription className="max-w-lg leading-6">
                Upload a UTF-8 CSV up to 25 MiB. The source stays unchanged while DataPilot
                profiles, checks, and prepares a governed change set.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-1">
              <button
                type="button"
                className="flex min-h-28 w-full items-center justify-between gap-4 rounded-[16px] border border-dashed border-border bg-muted/45 px-4 text-left transition-colors hover:border-primary/45 hover:bg-policy-tint/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <span>
                  <span className="block text-base font-semibold">Choose a CSV file</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Nothing is changed without a reviewable action.
                  </span>
                </span>
                <ArrowRight aria-hidden="true" className="size-5 shrink-0 text-primary" />
              </button>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LockKeyhole aria-hidden="true" className="size-3.5" />
                Sensitive values are screened before semantic analysis.
              </div>
            </CardContent>
          </Card>
        </section>

        <aside aria-label="Verified demonstration" className="lg:sticky lg:top-6">
          <Card className="border border-border bg-ink text-white ring-0">
            <CardHeader>
              <Badge className="mb-3 bg-white/10 text-white ring-1 ring-white/15">
                Verified demo replay
              </Badge>
              <CardTitle className="text-xl text-white">Clinical NLP release candidate</CardTitle>
              <CardDescription className="leading-6 text-white/65">
                A deterministic, synthetic scenario built for a reliable offline walkthrough.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-white/10 border-y border-white/10">
                {checks.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 py-3.5">
                    <dt className="flex items-center gap-2 text-sm text-white/70">
                      <CheckCircle2 aria-hidden="true" className="size-4 text-[#7dd8c5]" />
                      {label}
                    </dt>
                    <dd className="font-mono text-xs font-semibold text-white">{value}</dd>
                  </div>
                ))}
              </dl>
              <Button
                size="lg"
                className="mt-5 min-h-12 w-full rounded-[14px] bg-white text-ink hover:bg-white/90"
              >
                Try verified demo
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Button>
              <p className="mt-3 text-center text-xs text-white/55">
                Synthetic data · No live model required
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-5 text-xs text-muted-foreground sm:px-6">
        <span>AI proposes · Policy decides · Rules execute</span>
        <span>Source artifacts remain immutable</span>
      </footer>
    </main>
  );
}
