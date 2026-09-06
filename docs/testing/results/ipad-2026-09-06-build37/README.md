# iPad build37 targeted map QA

Native test03 passed23.240seconds on exact leased iPad5DFE23AA-CEC0-4B07-A093-28D5C2C73AE0 at14:18UTC. Inspected screenshot shows14T#9128 moving27.5km/h toward Sibeliova, correctly labelled NEXT with30seconds remaining. The five sections are assembled without visible overlaps in this view. This is a live moving-state smoke test, not a deterministic reproduction of every dwell branch. Focused timeline tests cover the wrong-platform label regression.

Build37 changes only the current-platform timeline interpretation; model assets, viewer, skin importer and map texture pipeline retain build36 validation. The separate app-independent Simulator rotation issue remains documented in build36 evidence.
