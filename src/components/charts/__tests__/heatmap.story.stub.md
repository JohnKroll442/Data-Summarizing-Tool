# UX Event Contract – Double-Click to Parent Grid Filter

When `mode === 'TIME_SERIES'` and a cell is double-clicked in the rendered heatmap:

```ts
interface CellClickEvent {
  x: string;            // time bucket identifier (e.g. "2026-09-01")
  y: string;            // entity id  (e.g. "Supplier A")
  count: number;        // anomaly count (used to highlight intensity)
}
```

The Storybook host (or parent component) should run:
```ts
filterGrid({ timeBucket: cell.x, entity: cell.y });
```

The same event object shape is **universal** regardless of backend dataset columns because the facade now names the sentinel columns **x = timeBucket, y = entity**。

No engine changes required: the event bubbles up via the SARASA pattern already in place for classic mode.