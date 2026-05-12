# Checklist v6.2

1. Copiar todo este contenido sobre la carpeta del proyecto.
2. Confirmar que `server.js` empieza con: `// v6.2: no usa dotenv...`
3. Confirmar que `package.json` version es `1.2.2`.
4. Subir a Git:

```bash
git add -A
git commit -m "Fix v6.2 remove dotenv and force Docker rebuild"
git push
```

5. En EasyPanel usar Dockerfile, ruta `/Dockerfile`, build path `/`, proxy puerto `3001`.
6. Si sigue saliendo `Cannot find module dotenv`, EasyPanel sigue ejecutando imagen vieja: detener servicio, deploy nuevo o recrear la app apuntando al mismo repo.
