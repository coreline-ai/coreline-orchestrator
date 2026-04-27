# 03 Data Flow Contract — Summary

## Purpose
This contract describes the end-to-end data flow the current backend supports and the data a frontend would consume.
The canonical detailed version is in `_workspace/03_data_flow_contract.md`.

## Main flows
1. Job intake → persistence → scheduling → worker start → result aggregation.
2. Session create/attach/detach/reattach → transcript persistence → live stream output.
3. Worker logs/artifacts/events → API read paths → client consumption.
4. Distributed readiness/health/capacity/metrics → operator visibility.

## Honest note
These flows are fully backed by the current backend/control-plane.
What is missing is a shipped frontend implementation that renders them in a browser UI.
