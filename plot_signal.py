#!/usr/bin/env python3
"""
plot_signal.py — inspect a steering-match CSV export.

Usage:
    python plot_signal.py steering-log-2026-08-12T14-30-00.csv

Shows, for each rotation axis (alpha/beta/gamma):
  - the raw angular-velocity trace
  - a low-pass version (the candidate "car turn" signal)
Vertical lines mark where you tapped "Mark Turn" (real corners).

The go/no-go read: on a real drive, the CAR's corners should show up as
clear, slow humps on ONE axis's low-pass line, standing out from the
faster hand jitter. If they do, the concept works with one phone.

Deps:  pip install pandas matplotlib numpy
"""

import sys
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt


def low_pass(x, dt, cutoff_hz=0.6):
    """Simple one-pole low-pass. Car turns are slow (<~0.6 Hz);
    hand jerks are faster. Tune cutoff after seeing real data."""
    x = np.asarray(x, dtype=float)
    rc = 1.0 / (2 * np.pi * cutoff_hz)
    alpha = dt / (rc + dt)
    y = np.empty_like(x)
    y[0] = x[0]
    for i in range(1, len(x)):
        y[i] = y[i - 1] + alpha * (x[i] - y[i - 1])
    return y


def main():
    if len(sys.argv) < 2:
        print("usage: python plot_signal.py <csv file>")
        sys.exit(1)

    df = pd.read_csv(sys.argv[1])
    t = df["t_sec"].to_numpy()
    dt = np.median(np.diff(t)) if len(t) > 1 else 0.016
    print(f"{len(df)} samples, ~{1/dt:.0f} Hz, {t[-1]:.1f} s total")

    marks = t[df["mark"] == 1] if "mark" in df else []
    axes = ["alpha", "beta", "gamma"]
    colors = {"alpha": "#3d8bff", "beta": "#f0883e", "gamma": "#a371f7"}

    fig, axs = plt.subplots(3, 1, figsize=(11, 8), sharex=True)
    for ax_name, sp in zip(axes, axs):
        raw = df[ax_name].to_numpy()
        lp = low_pass(raw, dt, cutoff_hz=0.6)
        sp.plot(t, raw, color=colors[ax_name], alpha=0.35, lw=0.8, label=f"{ax_name} raw")
        sp.plot(t, lp, color=colors[ax_name], lw=2.0, label=f"{ax_name} low-pass (car?)")
        for m in marks:
            sp.axvline(m, color="#e6edf3", ls="--", lw=0.8, alpha=0.6)
        sp.set_ylabel("°/s")
        sp.legend(loc="upper right", fontsize=8)
        sp.grid(alpha=0.2)
        # crude separability hint: how much of the energy is in the slow band
        ratio = np.std(lp) / (np.std(raw) + 1e-9)
        sp.set_title(f"{ax_name}   slow/total energy ≈ {ratio:.2f}", fontsize=10, loc="left")

    axs[-1].set_xlabel("time (s)   ·   dashed = marked corners")
    fig.suptitle("Steering Match — axis signals (find the axis where car corners stand out)")
    fig.tight_layout()
    out = sys.argv[1].rsplit(".", 1)[0] + ".png"
    fig.savefig(out, dpi=130)
    print(f"saved {out}")
    plt.show()


if __name__ == "__main__":
    main()
