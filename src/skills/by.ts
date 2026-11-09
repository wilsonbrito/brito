/**
 * Quem gerou a última resposta da reflexão: `slm` (modelo local) ou o id do modelo remoto. Fica num módulo próprio
 * para `withSlm` (que decide o motor) e `reflect` (que grava a autoria na skill) não dependerem um do outro.
 */
let last = "";
export const setReflector = (by: string) => { last = by; };
export const lastReflector = () => last;
