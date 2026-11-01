```arcsync
flowchart LR
  a[A]@{ icon: "aws:lamda" } --> b
  b ->> c
  subgraph s[S]
    x@{ expands: "nope" }
```
