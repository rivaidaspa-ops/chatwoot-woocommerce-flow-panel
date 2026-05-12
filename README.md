# Chatwoot WooCommerce Flow Panel v6.9

Actualización enfocada en edición de pedidos sin bloqueo de pantalla.

## Cambios v6.9

- Edición de pedido en panel lateral independiente.
- Botones Volver / Cerrar visibles.
- Guardar estado y nota sin bloquear la interfaz.
- Cancelar pedido.
- Eliminar pedido enviándolo a papelera de WooCommerce.
- Generar link Flow desde pedido existente.
- Buscar pedido por número, email, nombre o SKU.
- Interfaz más moderna para detalle de pedido.

## Deploy

```bash
git add -A
git commit -m "Upgrade v6.9 order drawer delete cancel and Flow actions"
git push
```

En EasyPanel usar Dockerfile, ruta `/`, proxy al puerto 3001.
