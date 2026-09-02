/**
 * StoryAnomalyChart.controller.js
 *
 * Drives the VizFrame horizontal grouped bar chart showing, per story:
 *   - Total action instances  (blue bar)
 *   - Anomaly action instances (amber bar)
 *   - Anomaly %               (tooltip only)
 *
 * Key responsibilities:
 *   1. Hold / receive raw story data.
 *   2. Sort descending by anomaly count and slice to the top-N limit.
 *   3. Compute the anomaly ratio for each row.
 *   4. Push the prepared data into a JSONModel bound to the VizFrame.
 *   5. Apply all vizProperties (colors, labels, axes, tooltip format).
 *   6. Connect the Popover to the VizFrame for click-through detail cards.
 *   7. Keep the chart title and frame height in sync when N changes.
 */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel"
], function (Controller, JSONModel) {
    "use strict";

    // ─────────────────────────────────────────────────────────────────────────
    // Sample dataset
    // Replace with a real OData / REST call or pass data in from a parent
    // component via the model. Each row needs { story, total, anomalies }.
    // ─────────────────────────────────────────────────────────────────────────
    var RAW_DATA = [
        { story: "Procurement Approval",     total: 920,  anomalies: 380 },
        { story: "Goods Receipt",            total: 756,  anomalies: 300 },
        { story: "Invoice Verification",     total: 880,  anomalies: 210 },
        { story: "Purchase Order Creation",  total: 620,  anomalies: 195 },
        { story: "Vendor Evaluation",        total: 540,  anomalies: 175 },
        { story: "Stock Transfer",           total: 700,  anomalies: 160 },
        { story: "Material Master Update",   total: 480,  anomalies: 140 },
        { story: "Payment Run",              total: 410,  anomalies: 120 },
        { story: "Delivery Processing",      total: 390,  anomalies:  95 },
        { story: "Customer Returns",         total: 310,  anomalies:  80 },
        { story: "Billing Document",         total: 260,  anomalies:  55 },
        { story: "Credit Memo",              total: 190,  anomalies:  30 }
    ];

    // Default number of stories shown on first render.
    var DEFAULT_TOP_N = 10;

    // SAP Horizon-compatible palette: blue (Total) and amber (Anomalies).
    var COLOR_TOTAL     = "#1873B4";
    var COLOR_ANOMALIES = "#E8A000";

    // Minimum frame height, and extra pixels allocated per story group.
    var MIN_HEIGHT_PX   = 300;
    var PX_PER_STORY    = 72;   // accommodates both bars + breathing room

    // ─────────────────────────────────────────────────────────────────────────

    return Controller.extend("chart.controller.StoryAnomalyChart", {

        // ── Lifecycle ────────────────────────────────────────────────────────

        onInit: function () {
            // Create the JSONModel and attach it to the view immediately so
            // the VizFrame's data binding resolves as soon as data is set.
            this._oModel = new JSONModel({ stories: [] });
            this.getView().setModel(this._oModel);

            // Initial render: top 10 sorted by anomaly count.
            this._applyTopN(DEFAULT_TOP_N);

            // vizProperties are applied once after the chart is initialised.
            // The chart is not guaranteed to be fully rendered synchronously,
            // so we defer until the next event loop tick.
            setTimeout(this._configureVizFrame.bind(this), 0);

            // Connect the built-in detail Popover.
            setTimeout(this._connectPopover.bind(this), 0);
        },

        // ── Event handlers ───────────────────────────────────────────────────

        /**
         * Fired when the StepInput value changes.
         * Re-slices the dataset and updates the chart title and height.
         */
        onTopNChange: function (oEvent) {
            var n = parseInt(oEvent.getParameter("value"), 10);
            if (isNaN(n) || n < 1) { return; }
            this._applyTopN(n);
        },

        // ── Private helpers ──────────────────────────────────────────────────

        /**
         * Sort RAW_DATA by anomaly count (desc), take the top-N rows, add the
         * computed anomalyRatio field, and push into the bound model.
         * Also updates the chart title and frame height to match N.
         *
         * @param {number} n  Number of stories to display.
         */
        _applyTopN: function (n) {
            var aSlice = RAW_DATA
                .slice()                                      // non-destructive copy
                .sort(function (a, b) {
                    return b.anomalies - a.anomalies;        // descending by anomaly count
                })
                .slice(0, n)
                .map(function (item) {
                    var ratio = item.total > 0
                        ? parseFloat(((item.anomalies / item.total) * 100).toFixed(1))
                        : 0;
                    return {
                        story:        item.story,
                        total:        item.total,
                        anomalies:    item.anomalies,
                        anomalyRatio: ratio             // e.g. 41.3  (rendered as "41.3 %")
                    };
                });

            this._oModel.setProperty("/stories", aSlice);
            this._updateChartMeta(n, aSlice);
        },

        /**
         * Refresh the chart title text and the VizFrame height whenever N or
         * the data slice changes.
         */
        _updateChartMeta: function (n, aSlice) {
            var oVizFrame = this.getView().byId("vizFrame");
            if (!oVizFrame) { return; }

            // Dynamic height: enough room for every story group.
            var nHeight = Math.max(MIN_HEIGHT_PX, aSlice.length * PX_PER_STORY);
            oVizFrame.setHeight(nHeight + "px");

            // Update just the title text inside vizProperties.
            oVizFrame.setVizProperties({
                title: {
                    visible: true,
                    text: "Stories by Anomaly Count — Top " + n
                }
            });

            // Update the summary label in the toolbar.
            var oLabel = this.getView().byId("ratioLabel");
            if (oLabel && aSlice.length > 0) {
                var nTotalAnomalies = aSlice.reduce(function (s, r) { return s + r.anomalies; }, 0);
                var nTotalActions   = aSlice.reduce(function (s, r) { return s + r.total; }, 0);
                var overallPct = nTotalActions > 0
                    ? ((nTotalAnomalies / nTotalActions) * 100).toFixed(1)
                    : "0.0";
                oLabel.setText(
                    nTotalAnomalies.toLocaleString() + " anomalies across " +
                    nTotalActions.toLocaleString()   + " actions (" + overallPct + "%)"
                );
            }
        },

        /**
         * Set all static vizProperties on the VizFrame:
         *   - Color palette (blue = Total, amber = Anomalies)
         *   - Data labels on bars
         *   - Axis formatting
         *   - Tooltip format string for the Anomaly % measure
         *   - Legend
         *   - Interaction mode
         *
         * Called once after init (deferred by one tick so the chart control is
         * rendered before we write to its properties).
         */
        _configureVizFrame: function () {
            var oVizFrame = this.getView().byId("vizFrame");
            if (!oVizFrame) { return; }

            oVizFrame.setVizProperties({

                // ── Plot area ─────────────────────────────────────────────────
                plotArea: {
                    // Palette index matches FeedItem valueAxis measure order:
                    // [0] Total → SAP blue, [1] Anomalies → SAP amber/orange
                    colorPalette: [COLOR_TOTAL, COLOR_ANOMALIES],

                    dataLabel: {
                        visible: true,
                        formatString: "##,##0",     // thousands separator, no decimals
                        style: {
                            fontSize: "12px",
                            color: "#32363a"
                        }
                    },

                    // Spacing between the two bars within a story group and
                    // between consecutive story groups.
                    gap: {
                        inner: 0.25,    // between Total and Anomalies bars (0–1)
                        outer: 0.5      // between story groups (0–1)
                    }
                },

                // ── Legend ────────────────────────────────────────────────────
                legend: {
                    visible: true,
                    title: { visible: false }
                },

                // ── Chart title ───────────────────────────────────────────────
                // Text is set dynamically in _updateChartMeta; properties here
                // set the static style only.
                title: {
                    visible: true,
                    text: "Stories by Anomaly Count — Top " + DEFAULT_TOP_N,
                    style: {
                        fontSize: "16px",
                        fontWeight: "bold",
                        color: "#32363a"
                    }
                },

                // ── Value axis (X — horizontal) ───────────────────────────────
                valueAxis: {
                    title: { visible: false },
                    label: { formatString: "##,##0" }
                },

                // ── Category axis (Y — story names) ───────────────────────────
                categoryAxis: {
                    title: { visible: false },
                    label: {
                        // Prevent long story names from being truncated.
                        truncatedLabelRatio: 0
                    }
                },

                // ── Tooltip ───────────────────────────────────────────────────
                // The default hover card already shows Story, Total, and
                // Anomalies from the valueAxis measures. The tooltip FeedItem
                // adds Anomaly % here; its format string adds the "%" suffix.
                tooltip: {
                    visible: true,
                    formatString: {
                        "Anomaly %": "##,##0.0'%'"
                    }
                },

                // ── Interaction ───────────────────────────────────────────────
                interaction: {
                    selectability: {
                        // EXCLUSIVE: only one bar selected at a time so the
                        // Popover always shows a single story's detail.
                        mode: "EXCLUSIVE"
                    }
                }
            });
        },

        /**
         * Wire the Popover control to the VizFrame so that clicking any bar
         * opens the built-in SAP viz detail card showing all measure values
         * for that story (Total, Anomalies, Anomaly %).
         */
        _connectPopover: function () {
            var oVizFrame = this.getView().byId("vizFrame");
            var oPopover  = this.getView().byId("popover");
            if (!oVizFrame || !oPopover) { return; }
            oPopover.connect(oVizFrame.getVizUid());
        }

    });
});
