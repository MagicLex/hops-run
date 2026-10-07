"""Direct logit readout engine, vendored from TheoLeeCJ/SemIf (MIT).

Upstream: https://github.com/TheoLeeCJ/SemIf, src/semif_phase1, commit
1f2dea3e25379f9dfc98cb83c324f00ab5deda37 (2026-09-21).

Local change: ``core.resolve_device`` accepts ``cpu`` and falls back to it when
no CUDA or MPS device is present. Scoring code is unmodified.
"""
