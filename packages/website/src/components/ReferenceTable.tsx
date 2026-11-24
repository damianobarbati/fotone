import cx from 'clsx-tw';

type ReferenceColumn = { label: string; nowrap?: boolean };

type ReferenceTableProps = {
  className?: string;
  label: string;
  columns: ReferenceColumn[];
  rows: [string, ...string[]][];
};

export const ReferenceTable = ({ className, label, columns, rows }: ReferenceTableProps) => {
  const result = (
    <div className={cx('table-shell overflow-x-auto', className)}>
      <table className="w-full text-left text-sm max-phone:[&_:is(th,td)]:px-2" aria-label={label}>
        <thead className="table-head">
          <tr>
            {columns.map(({ label: column }) => (
              <th key={column} className="table-header-cell" scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, ...values]) => (
            <tr key={name} className="table-row">
              <th className="table-cell font-normal wrap-anywhere align-top" scope="row">
                <code>{name}</code>
              </th>
              {values.map((value, index) => {
                const column = columns[index + 1];

                const cell = (
                  <td
                    key={column.label}
                    className={cx('table-cell align-top', column.nowrap ? 'whitespace-nowrap' : 'wrap-anywhere')}
                  >
                    {value}
                  </td>
                );

                return cell;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return result;
};
