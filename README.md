# Vendix Hub v8.4

Actualización v8.4:

- Nombre comercial de la app: Vendix Hub.
- Permite configurar el nombre comercial de la tienda por país desde Credenciales: Chile y Colombia.
- Asistente de venta cambia automáticamente por país: Chile o Colombia.
- Prompts IA configurables por país desde Credenciales.
- Soporte para OpenAI/ChatGPT, DeepSeek, Gemini y webhook personalizado.
- Recomendaciones usan métodos de pago y envío disponibles desde WooCommerce.
- Generador de cupón recomendado según país, carrito, pago y envío.
- Mantiene RUT AliDropship Chile, ciudades/departamentos Dropi Colombia, códigos postales, stock primero y bloqueo de variaciones sin stock.

Subir:

```bash
git add -A
git commit -m "actualizar vendix nombres tienda por pais"
git push
```

EasyPanel: Dockerfile, puerto 3001, variables mínimas iguales a v8.x. Las credenciales se administran desde el modal Credenciales.
