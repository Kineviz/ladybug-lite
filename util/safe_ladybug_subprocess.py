import multiprocessing as mp
import pandas as pd
import real_ladybug as lbug
import pickle
import traceback

def lbug_worker(db_path, conn_pipe):
    try:
        db = lbug.Database(db_path)
        conn = lbug.Connection(db)

        while True:
            msg = conn_pipe.recv()
            if msg == "__close__":
                break
            query = msg
            try:
                result = conn.execute(query)
                df = result.get_as_df()
                conn_pipe.send(("ok", pickle.dumps(df)))
                result.close()
                conn.close()
                db.close()
            except Exception as e:
                conn_pipe.send(("error", traceback.format_exc()))
    except Exception as e:
        conn_pipe.send(("error", traceback.format_exc()))
    finally:
        conn_pipe.close()


class SafeLadybugSubprocess:
    def __init__(self, db_path):
        self.db_path = db_path
        self.parent_conn, self.child_conn = mp.Pipe()
        self.process = mp.Process(target=lbug_worker, args=(self.db_path, self.child_conn))
        self.process.start()

    def execute(self, query: str) -> pd.DataFrame:
        self.parent_conn.send(query)
        status, payload = self.parent_conn.recv()
        if status == "ok":
            return pickle.loads(payload)
        else:
            raise RuntimeError(f"Error in Ladybug subprocess:\n{payload}")

    def close(self):
        if self.process.is_alive():
            self.parent_conn.send("__close__")
            self.process.join()
        self.parent_conn.close()
        self.child_conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
