import { getCloudState, signInWithGoogle, signOut, subscribeCloud, syncAll, type CloudState } from "../cloud/sync";

/** ヘッダーに置く、ログイン・同期状態の表示。 */
export function createCloudPanel(): HTMLElement {
  const root = document.createElement("div");
  root.className = "cloud-panel";

  const status = document.createElement("span");
  status.className = "cloud-status";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cloud-button";

  function render(s: CloudState): void {
    root.dataset.status = s.status;
    if (s.status === "signedOut") {
      status.textContent = "";
      status.title = "";
      button.textContent = "Googleでログイン";
      button.onclick = () => void signInWithGoogle();
      return;
    }
    const label =
      s.status === "syncing" ? "同期中…" : s.status === "error" ? "同期できませんでした" : "同期済み";
    status.textContent = `${s.email ?? ""} ・ ${label}`;
    status.title = s.message ?? "";
    button.textContent = s.status === "error" ? "もう一度同期" : "ログアウト";
    button.onclick = s.status === "error" ? () => void syncAll() : () => void signOut();
  }

  root.append(status, button);
  subscribeCloud(render);
  render(getCloudState());
  return root;
}
