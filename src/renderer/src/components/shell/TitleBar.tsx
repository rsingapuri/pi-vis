import type React from "react";
import "./TitleBar.css";

export function TitleBar(): React.ReactElement {
  return (
    <div className="titlebar">
      <span className="titlebar__title">Pi-Vis</span>
    </div>
  );
}
