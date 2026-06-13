import type React from "react";
import "./PiNotFound.css";

interface PiNotFoundProps {
  onRecheck: () => void;
}

export function PiNotFound({ onRecheck }: PiNotFoundProps): React.ReactElement {
  return (
    <div className="pi-not-found">
      <div className="pi-not-found__icon">π</div>
      <h1 className="pi-not-found__title">pi not found</h1>
      <p className="pi-not-found__desc">
        Pi-Vis requires the <code>pi</code> coding agent CLI to be installed.
      </p>
      <div className="pi-not-found__instructions">
        <p>Install pi globally:</p>
        <pre className="pi-not-found__code">
          npm i -g --ignore-scripts @earendil-works/pi-coding-agent
        </pre>
        <p>Then restart Pi-Vis, or:</p>
      </div>
      <button type="button" className="pi-not-found__btn" onClick={onRecheck}>
        Re-check for pi
      </button>
    </div>
  );
}
