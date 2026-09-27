# Orinasu

作曲支援アプリ。仕様は [SPEC.md](./SPEC.md) を参照。

## 開発

```bash
npm install
npm run dev
```

## GitHub Pages 公開設定（最初の1回だけ・オーナー作業）

1. GitHubでこのリポジトリを開く。
2. 上部タブの「Settings」を押す。
3. 左メニューの「Pages」を押す。
4. 「Build and deployment」の「Source」を **GitHub Actions** に変更する。
5. これで、`main` ブランチに push されるたびに自動でビルド・公開される（`.github/workflows/deploy.yml`）。
6. 公開URLは `https://me4-0-4.github.io/Orinasu/` になる。
