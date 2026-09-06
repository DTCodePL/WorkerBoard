// Sprawdzanie zywotnosci procesu po PID, bez wysylania sygnalu zabijajacego.

export function isProcessAlive(pid: number): boolean {
  try {
    // Sygnal 0 nie zabija procesu - sluzy wylacznie do sprawdzenia,
    // czy PID istnieje i czy mamy do niego dostep.
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'EPERM') {
      // EPERM oznacza, ze proces istnieje, ale brakuje uprawnien do jego
      // sygnalizowania (typowe dla procesu innego uzytkownika) - to wciaz
      // dowod zycia procesu, nie jego braku.
      return true;
    }
    // ESRCH i kazdy inny kod oznaczaja brak procesu o tym PID.
    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
