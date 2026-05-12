# Checklist para subir v6.1 corregida

1. Copiar todos los archivos de esta carpeta dentro del repo actual.
2. Verificar que `.dockerignore` NO tenga `*`.
3. Ejecutar:

```bash
git add -A
git commit -m "Fix v6.1 Dockerfile dependencies and paginated catalog"
git push
```

4. En GitHub deben verse: `server.js`, `package.json`, `Dockerfile`, `public/`, `data/`.
5. En EasyPanel usar Dockerfile, ruta `/Dockerfile`, proxy puerto `3001`.
