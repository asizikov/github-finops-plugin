export function pollUpdates(check, onError) {
    let stopped = false;
    let timer;
    async function run() {
        try {await check();}
        catch (error) {if (!stopped) onError(error);}
        finally {
            if (!stopped) timer = setTimeout(() => void run(), 15 * 60 * 1000);
        }
    }
    void run();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
